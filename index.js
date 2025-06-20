'use strict';
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mysql = require('mysql2/promise');
const fs = require('fs').promises;

console.log('--- LAMBDA COLD START ---');

// Define variables for the clients, but do not initialize them here.
let dbPool;
let genAI;

// --- Helper Functions ---

async function getSystemPrompt(userRole) {
    // First, check if the required files exist. This helps debug deployment issues.
    const requiredFiles = ['schema.txt', 'sampledata.txt', 'example queries.txt'];
    for (const file of requiredFiles) {
        try {
            await fs.access(file);
        } catch (error) {
            // If a file is missing, throw a specific error that will be sent to the user.
            throw new Error(`Critical file not found: ${file}. Please ensure it is included in your SAM deployment package.`);
        }
    }

    try {
        const schema = await fs.readFile('schema.txt', 'utf-8');
        const sample = await fs.readFile('sampledata.txt', 'utf-8');
        const exampleQueries = await fs.readFile('example queries.txt', 'utf-8');

        let roleBasedInstructions = '';
        if (userRole === 'Employee') {
            roleBasedInstructions = `6. **Strict Data Scoping**: The user is an 'Employee'. ALL generated SQL queries MUST be strictly scoped to the user's own 'user_id'. The query must include a 'WHERE' clause filtering by the 'user_id' provided in the prompt (e.g., 'WHERE user_id = "THE_USER_ID"'). For tables without a direct user_id column, use appropriate JOINs to filter by the user's ID through related tables. Do not use the user's name (e.g., "Rahul Verma") for filtering; always use the 'user_id'. If the user asks about another person, you MUST refuse. For such cases, set "sql" to "ACCESS_DENIED" and "confirmation_message" to "Access Denied: You can only view your own information."`;
        } else if (userRole === 'Manager') {
            roleBasedInstructions = `6. **Manager Data Scoping**: The user is a 'Manager'. They can view their own data and the data of employees who report directly to them (whose 'manager_id' is the manager's 'user_id'). For tables without a direct manager_id reference, use appropriate JOINs to establish the relationship through the Users table. For queries about other employees, you must first verify this relationship. If the request is for an employee not under their management, or for another manager, treat it as an access denial. For such cases, set "sql" to "ACCESS_DENIED" and "confirmation_message" to "Access Denied: You can only view information for yourself or your direct reports." When querying for direct reports, the SQL should look like '... WHERE manager_id = "THE_MANAGER_USER_ID"' or use JOINs to establish the relationship.`;
        } else if (userRole === 'Admin') {
            roleBasedInstructions = `6. **Admin Data Scoping**: The user is an 'Admin'. They can view data for ANY user within their 'organization_id'. All queries MUST still be scoped by the 'organization_id' provided in the prompt to ensure organizational data isolation. For tables that don't have an organization_id column directly, use appropriate JOINs to establish the relationship through tables that do have this column.`;
        }
        
        const nameMappingRule = `7. **Name-to-ID Mapping**: The user's full name is provided in the prompt. If the user's question refers to their own name (e.g., "What is Amit Kumar's leave balance?" when the user's name is Amit Kumar), treat this as a query for their own data. The SQL query MUST use the 'user_id' provided in the prompt for filtering, not the name.`;
        
        const ambiguityRule = `8. **Handle Ambiguity**: If a query refers to a name that is not unique within the user's permitted scope (e.g., a manager has two reports named 'Amit'), do not generate SQL. Set "sql" to "AMBIGUOUS_QUERY" and for the "confirmation_message", ask the user to clarify by providing a last name or employee ID. Example: "There are multiple users named Amit. Please provide a last name or a unique ID."`;

        const securityRule = `9. **SQL Injection Prevention**: Never include user input directly in the SQL query without validation. Always use parameterized queries or prepared statements. Be vigilant about malicious input that might attempt SQL injection attacks.`;

        const subqueryRule = `10. **No Dangerous Subqueries**: Do not generate SQL with subqueries that might bypass access controls. All subqueries must maintain the same access control restrictions as the main query. Never use subqueries to access data that would be otherwise restricted from the user.`;

        let prompt = `You are an expert SQL writer and an AI assistant for a company named "Vipraco".
Your role is to take a user's question in natural language and convert it into a single, executable SQL query.

**Output Format:**
Your entire output MUST be a single JSON object. This object must have two keys:
1. "sql": A string containing the single, executable SQL query.
2. "confirmation_message": A user-friendly, natural-language string confirming what action was taken. For example: "Found Rahul Verma's base salary." or "Found the leave balance for Geeta Devi.".

**Constraints & Rules:**
1.  **READ-ONLY ACCESS**: You are ONLY allowed to generate SELECT queries. NEVER generate UPDATE, INSERT, DELETE or any other write operations, even if the user explicitly asks for them. If a user asks to update or modify data, respond with "sql": "ACCESS_DENIED" and "confirmation_message": "This system only allows viewing data. Updates must be performed through the HR department."
2.  **Security First**: The "sql" value MUST NOT contain any query that modifies the database schema (e.g., DROP, ALTER, TRUNCATE) or modifies data (e.g., DELETE, UPDATE, INSERT). You are only allowed to generate SELECT queries.
3.  **Single Action**: You can only perform one action (one SQL query) per prompt. 
4.  **Multi-Action Detection**: If the user asks to do multiple distinct actions (e.g., "update salary AND update leaves"), you MUST NOT generate SQL. Instead, set the "sql" value to "MULTI_ACTION_ERROR" and the "confirmation_message" to "Your request involves multiple actions. Please separate them into individual prompts for clarity and reliability."
5.  **Context is Key**: Use the provided database schema and sample data to understand the table structure and find the correct IDs for users like 'Amit' or 'Geeta'. The user's 'organization_id', 'user_id', and 'role' will be provided in the prompt for context.
6.  **Relevance**: If a question is unrelated to the HR schema (e.g., "What is the capital of France?"), you must not generate SQL. Set the "sql" value to "IRRELEVANT". For the "confirmation_message", provide a helpful response that politely declines the off-topic question and guides the user back to the HR assistant's capabilities. For example: "I am an HR assistant for Vipraco and can only answer questions about employee data, leave, payroll, and company policies. How can I help you with an HR-related query?"
${roleBasedInstructions}
${nameMappingRule}
${ambiguityRule}
${securityRule}
${subqueryRule}

**Database Schema:**
---
${schema}
---

**Sample Data (for reference on data format):**
---
${sample}
---

**Example questions you can answer:**
---
${exampleQueries}
---
`;
        return prompt;
    } catch (error) {
        console.error("Error reading context files:", error);
        throw new Error("Could not build system prompt.");
    }
}

function isQuerySafe(sql) {
    // SECURITY: Only allow SELECT queries - restrict all write operations
    const upperSql = sql.toUpperCase().trim();
    
    // Check if the query starts with SELECT
    if (!upperSql.startsWith('SELECT')) {
        console.log("SECURITY BLOCK: Non-SELECT query rejected:", sql);
        return false;
    }
    
    // Additional security checks for dangerous operations
    const unsafeKeywords = [
        'DROP', 'TRUNCATE', 'ALTER', 'DELETE', 'UPDATE', 'INSERT',
        'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK',
        'CREATE', 'RENAME', 'SHUTDOWN', 'EXECUTE', 'EXEC'
    ];
    
    // Check for semicolon to prevent multiple statements
    if (upperSql.split(';').length > 2) { // allow one semicolon at the end
        console.log("SECURITY BLOCK: Multiple statements detected");
        return false;
    }

    for (const keyword of unsafeKeywords) {
        // Use word boundary check to prevent false positives (e.g. 'DROPDOWN' shouldn't match 'DROP')
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(upperSql)) {
            console.log(`SECURITY BLOCK: Unsafe keyword '${keyword}' detected`);
            return false;
        }
    }
    
    // Check for dangerous patterns like inline comments that might be used to bypass filters
    const dangerousPatterns = [
        '--', '/*', '*/', 
        /\bUNION\b.*\bSELECT\b/i,  // UNION-based injections
        /\bOR\b\s+[\'\"]?[01][\'\"]?\s*=\s*[\'\"]?[01][\'\"]?/i  // OR 1=1 type injections
    ];
    
    for (const pattern of dangerousPatterns) {
        if (typeof pattern === 'string' && upperSql.includes(pattern)) {
            console.log(`SECURITY BLOCK: Dangerous pattern '${pattern}' detected`);
            return false;
        } else if (pattern instanceof RegExp && pattern.test(sql)) {
            console.log(`SECURITY BLOCK: Dangerous regex pattern detected`);
            return false;
        }
    }

    return true;
}

exports.handler = async (event) => {
    console.log('--- HANDLER INVOCATION ---');
    console.log('EVENT:', JSON.stringify(event));

    // Extract path and method from the event
    // For REST API (API Gateway v1), the path is in event.path
    // For HTTP API (API Gateway v2), the path would be in event.rawPath
    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || (event.requestContext?.http?.method) || 'GET';
    
    console.log('PATH:', path);
    console.log('METHOD:', method);
    console.log('FULL EVENT OBJECT:', JSON.stringify(event, null, 2));
    console.log('REQUEST CONTEXT:', JSON.stringify(event.requestContext || {}, null, 2));
    console.log('HEADERS:', JSON.stringify(event.headers || {}, null, 2));

    // Enhanced path handling for router-service compatibility
    const pathParts = path.split('/').filter(Boolean);
    const lastPathPart = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '';
    
    console.log('Path parts:', pathParts);
    console.log('Last path part:', lastPathPart);
    
    // Try to handle paths with potential proxy patterns
    const normalizedPath = '/' + pathParts.join('/');
    const basePath = pathParts.length > 0 ? pathParts[0] : '';
    const remainingPath = pathParts.length > 1 ? '/' + pathParts.slice(1).join('/') : '';
    
    console.log('Normalized path:', normalizedPath);
    console.log('Base path:', basePath);
    console.log('Remaining path:', remainingPath);

    // Add CORS headers to all responses
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,x-user-id,x-organization-id",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    };

    // Handle OPTIONS requests (for CORS preflight)
    if (method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: headers,
            body: ''
        };
    }

    // Check for debug endpoint - extremely flexible matching
    if (lastPathPart === 'debug' || path.endsWith('/debug') || path.includes('/debug') || remainingPath === '/debug' || remainingPath.includes('/debug')) {
        console.log('DEBUG ENDPOINT MATCHED');
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ message: "Success from simple handler on /debug", success: true }),
        };
    }

    // Handle AI query endpoint - extremely flexible matching
    if (lastPathPart === 'ai-query' || path.endsWith('/ai-query') || path.includes('/ai-query') || remainingPath === '/ai-query' || remainingPath.includes('/ai-query')) {
        console.log('AI-QUERY ENDPOINT MATCHED');
        try {
            // Get the request body
            let body = {};
            if (event.body) {
                body = JSON.parse(event.body);
            }
            
            const prompt = body.prompt;
            const userId = event.headers['x-user-id'] || event.headers['X-User-Id'];
            const organizationId = event.headers['x-organization-id'] || event.headers['X-Organization-Id'];

            if (!prompt || !userId || !organizationId) {
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ message: 'Missing prompt, x-user-id, or x-organization-id in request', success: false })
                };
            }
            
            // Handle greetings and thanks
            const greetingWords = ['hi', 'hello', 'hey', 'greetings', 'good morning', 'good afternoon', 'good evening'];
            const thanksWords = ['thank', 'thanks', 'appreciate', 'grateful'];
            
            // Use the existing promptLower variable that's declared below
            let trimmedPrompt = prompt.toLowerCase().trim();
            
            // Check if the prompt is just a greeting
            if (greetingWords.some(word => trimmedPrompt === word || trimmedPrompt.startsWith(word + ' '))) {
                return {
                    statusCode: 200,
                    headers: headers,
                    body: JSON.stringify({ 
                        success: true, 
                        message: "Hello! I'm your HR assistant. How can I help you today? You can ask me about leaves, salary, attendance, or other HR-related information.",
                        data: []
                    })
                };
            }
            
            // Check if the prompt is a thank you
            if (thanksWords.some(word => trimmedPrompt.includes(word))) {
                return {
                    statusCode: 200,
                    headers: headers,
                    body: JSON.stringify({ 
                        success: true, 
                        message: "You're welcome! Is there anything else I can help you with?",
                        data: []
                    })
                };
            }
            
            // Handle identity queries directly without LLM - more reliable and faster
            const identityKeywords = ['my id', 'my user id', 'my employee id', 'my userid', 'who am i'];
            if (identityKeywords.some(keyword => trimmedPrompt.includes(keyword))) {
                return {
                    statusCode: 200,
                    headers: headers,
                    body: JSON.stringify({ 
                        success: true, 
                        message: `Your employee ID is ${userId}.`,
                        data: [{ user_id: userId }]
                    })
                };
            }
            
            // Detect leave application keywords and types for later processing
            const leaveApplicationKeywords = [
                'apply for leave', 'request leave', 'take leave', 
                'submit leave', 'need leave', 'want to apply for leave',
                'i want leave', 'apply leave', 'need time off',
                'apply for sick leave', 'apply for casual leave', 'apply for earned leave',
                'want sick leave', 'want casual leave', 'want earned leave',
                'need sick leave', 'need casual leave', 'need earned leave',
                'request sick leave', 'request casual leave', 'request earned leave'
            ];
            
            // Enhanced leave application detection
            const isLeaveApplicationRequest = leaveApplicationKeywords.some(keyword => 
                trimmedPrompt.includes(keyword)
            ) || (
                // Also detect patterns like "I want to apply for leave" + any leave type
                (trimmedPrompt.includes('apply') || trimmedPrompt.includes('request') || 
                 trimmedPrompt.includes('want') || trimmedPrompt.includes('need')) && 
                (trimmedPrompt.includes('leave')) &&
                (trimmedPrompt.includes('sick') || trimmedPrompt.includes('casual') || 
                 trimmedPrompt.includes('earned'))
            );
            
            console.log("Leave application detection result:", isLeaveApplicationRequest);
            
            // Check if this is a leave application with a specified leave type
            const leaveTypeKeywords = {
                'sick leave': 'Sick Leave',
                'casual leave': 'Casual Leave',
                'earned leave': 'Earned Leave',
                'sick': 'Sick Leave',
                'casual': 'Casual Leave',
                'earned': 'Earned Leave'
            };
            
            let specifiedLeaveType = null;
            for (const [keyword, formalName] of Object.entries(leaveTypeKeywords)) {
                if (trimmedPrompt.includes(keyword)) {
                    specifiedLeaveType = formalName;
                    console.log(`Detected leave type: ${formalName} from keyword: ${keyword}`);
                    break;
                }
            }
            
            // Improved detection for follow-up leave type responses
            // Check if this is a simple single word response that is a leave type
            const isSingleWordLeaveType = 
                // Is it a very short message (1-2 words)
                (prompt.split(' ').length <= 2) && 
                // And it contains one of our leave type keywords
                (trimmedPrompt.includes('sick') || 
                 trimmedPrompt.includes('casual') || 
                 trimmedPrompt.includes('earned'));
            
            console.log("Single word leave type check:", isSingleWordLeaveType);
            
            // Handle leave application response
            const isLeaveTypeResponse = 
                // Either the flag was set in the previous request
                (body.leave_application_pending === true) || 
                // Or this is a simple single-word response with a leave type
                isSingleWordLeaveType;
            
            console.log("Leave type response check:", {
                isPending: body.leave_application_pending === true,
                isSingleWord: isSingleWordLeaveType,
                hasSick: trimmedPrompt.includes('sick'),
                hasCasual: trimmedPrompt.includes('casual'),
                hasEarned: trimmedPrompt.includes('earned'),
                isLeaveTypeResponse: isLeaveTypeResponse
            });
            
            // LAZY INITIALIZATION: Create clients on first request.
            if (!dbPool) {
                console.log("Creating database pool");
                
                // Check if all required database env variables are set
                const requiredDbEnvVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DB_PORT'];
                const missingVars = requiredDbEnvVars.filter(varName => !process.env[varName]);
                
                if (missingVars.length > 0) {
                    const errorMsg = `Missing database environment variables: ${missingVars.join(', ')}`;
                    console.error(errorMsg);
                    throw new Error(errorMsg);
                }
                
                console.log("Database env vars:", {
                    host: process.env.DB_HOST,
                    user: process.env.DB_USER,
                    dbName: process.env.DB_NAME,
                    port: process.env.DB_PORT
                });
                
                try {
                    dbPool = mysql.createPool({
                        host: process.env.DB_HOST,
                        user: process.env.DB_USER,
                        password: process.env.DB_PASSWORD,
                        database: process.env.DB_NAME,
                        port: process.env.DB_PORT,
                        waitForConnections: true,
                        connectionLimit: 10,
                        queueLimit: 0
                    });
                    
                    // Test the connection
                    console.log("Testing database connection...");
                    await dbPool.execute('SELECT 1');
                    console.log("Database connection successful");
                } catch (error) {
                    console.error("Error initializing database connection:", error);
                    throw new Error(`Failed to initialize database connection: ${error.message}`);
                }
            } else {
                console.log("Using existing database pool");
            }

            if (!genAI) {
                if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "ENTER_YOUR_GEMINI_API_KEY") {
                    throw new Error('GEMINI_API_KEY is not set. Please deploy again and provide the key when prompted.');
                }
                genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            }

            // 1. Fetch user's role and name from the database
            const [users] = await dbPool.execute('SELECT role, first_name, last_name FROM Users WHERE user_id = ? AND organization_id = ?', [userId, organizationId]);

            if (users.length === 0) {
                return {
                    statusCode: 403,
                    headers: headers,
                    body: JSON.stringify({ message: 'User not found or not part of this organization.', success: false })
                };
            }
            
            const userRole = users[0].role;
            const userFullName = `${users[0].first_name} ${users[0].last_name}`;
            
            // Handle leave balance queries directly for reliability - AFTER DB INIT
            const leaveKeywords = ['my leave', 'leave balance', 'how many leaves', 'sick leave balance', 'casual leave balance', 'earned leave balance', 'leaves left', 'leaves remaining'];
            
            // Improved detection to avoid conflicts with leave application
            const isLeaveQuery = leaveKeywords.some(keyword => trimmedPrompt.includes(keyword)) && 
                               !(trimmedPrompt.includes('apply') || 
                                 trimmedPrompt.includes('request') || 
                                 trimmedPrompt.includes('submit') ||
                                 trimmedPrompt.includes('want to') ||
                                 trimmedPrompt.includes('need to'));
                                 
            if (isLeaveQuery) {
                console.log("LEAVE QUERY DETECTED: Applying special handling for better reliability");
                
                try {
                    // Direct query for leave balances
                    const [leaveData] = await dbPool.execute(
                        'SELECT * FROM LeaveBalances WHERE user_id = ? AND organization_id = ?', 
                        [userId, organizationId]
                    );
                    
                    if (leaveData.length === 0) {
                        return {
                            statusCode: 200,
                            headers: headers,
                            body: JSON.stringify({ 
                                success: true, 
                                message: "Sorry, I couldn't find any leave balance information for you in our records.",
                                data: []
                            })
                        };
                    }
                    
                    return {
                        statusCode: 200,
                        headers: headers,
                        body: JSON.stringify({ 
                            success: true, 
                            message: `Found your leave balance information.`,
                            data: leaveData
                        })
                    };
                } catch (error) {
                    console.error("Error processing direct leave query:", error);
                    // If direct query fails, continue with LLM-based approach
                    console.log("Falling back to LLM-based leave query");
                }
            }
            
            // Handle salary queries with special debugging - AFTER DB INIT
            const salaryKeywords = ['my salary', 'my base salary', 'my ctc', 'how much do i earn', 'how much do i make', 'my pay', 'my compensation'];
            const isSalaryQuery = salaryKeywords.some(keyword => trimmedPrompt.includes(keyword));
            if (isSalaryQuery) {
                console.log("SALARY QUERY DETECTED: Applying special handling for better reliability");
                
                try {
                    // Direct query for salary instead of using LLM to ensure access control
                    // For employees, this is a safer approach for salary data
                    const [salaryData] = await dbPool.execute(
                        'SELECT * FROM PayrollData WHERE user_id = ? AND organization_id = ?', 
                        [userId, organizationId]
                    );
                    
                    if (salaryData.length === 0) {
                        return {
                            statusCode: 200,
                            headers: headers,
                            body: JSON.stringify({ 
                                success: true, 
                                message: "Sorry, I couldn't find any salary information for you in our records.",
                                data: []
                            })
                        };
                    }
                    
                    return {
                        statusCode: 200,
                        headers: headers,
                        body: JSON.stringify({ 
                            success: true, 
                            message: `Found your salary information.`,
                            data: salaryData
                        })
                    };
                } catch (error) {
                    console.error("Error processing direct salary query:", error);
                    // If direct query fails, continue with LLM-based approach
                    console.log("Falling back to LLM-based salary query");
                }
            }
            
            // If this is a leave application request - PROCESS AFTER DB INIT
            if (isLeaveApplicationRequest) {
                console.log("LEAVE APPLICATION REQUEST DETECTED: ", {
                    prompt: trimmedPrompt,
                    leaveType: specifiedLeaveType,
                    dbPoolExists: !!dbPool,
                    organizationId,
                    userId
                });
                
                // If no leave type specified, ask the user for the type
                if (!specifiedLeaveType) {
                    // Store the pending leave application in a database or session store
                    // This allows us to track state between requests
                    try {
                        // Check if there's already a pending leave application table
                        const [tableExists] = await dbPool.execute(
                            "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = ? AND table_name = 'PendingLeaveApplications'",
                            [process.env.DB_NAME]
                        );
                        
                        if (tableExists[0].count === 0) {
                            // Create the table if it doesn't exist
                            await dbPool.execute(`
                                CREATE TABLE PendingLeaveApplications (
                                    id INT AUTO_INCREMENT PRIMARY KEY,
                                    user_id VARCHAR(50) NOT NULL,
                                    organization_id VARCHAR(50) NOT NULL,
                                    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                    status VARCHAR(20) DEFAULT 'PENDING',
                                    UNIQUE KEY (user_id, organization_id)
                                )
                            `);
                            console.log("Created PendingLeaveApplications table");
                        }
                        
                        // First delete any existing pending applications for this user
                        await dbPool.execute(
                            'DELETE FROM PendingLeaveApplications WHERE user_id = ? AND organization_id = ?',
                            [userId, organizationId]
                        );
                        
                        // Insert the new pending application
                        await dbPool.execute(
                            'INSERT INTO PendingLeaveApplications (user_id, organization_id) VALUES (?, ?)',
                            [userId, organizationId]
                        );
                        
                        console.log("Stored pending leave application in database");
                    } catch (error) {
                        console.error("Error storing pending leave application:", error);
                        // Continue even if we couldn't store the state - we'll rely on the client-side flag
                    }
                    
                    return {
                        statusCode: 200,
                        headers: headers,
                        body: JSON.stringify({ 
                            success: true, 
                            message: "What type of leave would you like to apply for? Please specify: Sick Leave, Casual Leave, or Earned Leave.",
                            data: [],
                            leave_application_pending: true
                        })
                    };
                }
                
                try {
                    // Additional check for database connection
                    if (!dbPool) {
                        console.error("Database pool is not initialized!");
                        throw new Error("Database pool is not initialized");
                    }
                    
                    console.log("Executing query to check leave balance");
                    
                    // First check if the user has this type of leave available
                    const [leaveBalances] = await dbPool.execute(
                        'SELECT * FROM LeaveBalances WHERE user_id = ? AND organization_id = ? AND leave_type = ?', 
                        [userId, organizationId, specifiedLeaveType]
                    );
                    
                    console.log(`Checking leave balance for ${specifiedLeaveType}:`, leaveBalances);
                    
                    // Get all leave types for the user to calculate total leaves used
                    const [allLeaveTypes] = await dbPool.execute(
                        'SELECT leave_type, total_allotted, leaves_taken, leaves_pending_approval FROM LeaveBalances WHERE user_id = ? AND organization_id = ?', 
                        [userId, organizationId]
                    );
                    
                    console.log("All leave types for user:", allLeaveTypes);
                    
                    // Calculate total leaves used across all leave types
                    let totalLeavesUsed = 0;
                    let defaultAllotment = 10; // Default allotment if no leave types exist
                    
                    if (allLeaveTypes.length > 0) {
                        // Sum up all leaves taken and pending
                        totalLeavesUsed = allLeaveTypes.reduce((sum, leave) => 
                            sum + leave.leaves_taken + leave.leaves_pending_approval, 0);
                        
                        // Get the total_allotted value from the first leave type
                        // This assumes all leave types have the same total_allotted value
                        defaultAllotment = allLeaveTypes[0].total_allotted;
                    }
                    
                    console.log("Total leaves used across all types:", totalLeavesUsed);
                    console.log("Default allotment:", defaultAllotment);
                    
                    // Calculate available leaves
                    const availableLeaves = defaultAllotment - totalLeavesUsed;
                    
                    if (availableLeaves <= 0) {
                        return {
                            statusCode: 200,
                            headers: headers,
                            body: JSON.stringify({ 
                                success: false, 
                                message: `You don't have any leave balance available. You've used ${totalLeavesUsed} out of ${defaultAllotment} total leave days.`,
                                data: []
                            })
                        };
                    }
                    
                    // If the specified leave type doesn't exist for this user, create it
                    if (leaveBalances.length === 0) {
                        console.log(`Leave type ${specifiedLeaveType} not found for user. Creating it...`);
                        
                        // Insert the new leave type
                        await dbPool.execute(
                            'INSERT INTO LeaveBalances (organization_id, user_id, leave_type, total_allotted, leaves_taken, leaves_pending_approval, last_updated) VALUES (?, ?, ?, ?, 0, 1, NOW())',
                            [organizationId, userId, specifiedLeaveType, defaultAllotment]
                        );
                        
                        console.log(`Created new leave type ${specifiedLeaveType} for user with 1 pending approval`);
                    } else {
                        // Update leaves_pending_approval for the specified leave type
                        await dbPool.execute(
                            'UPDATE LeaveBalances SET leaves_pending_approval = leaves_pending_approval + 1, last_updated = NOW() WHERE user_id = ? AND organization_id = ? AND leave_type = ?', 
                            [userId, organizationId, specifiedLeaveType]
                        );
                        
                        console.log(`Updated leave_pending_approval for ${specifiedLeaveType}`);
                    }
                    
                    // Get manager information to include in the response
                    const [managerInfo] = await dbPool.execute(
                        'SELECT u2.first_name, u2.last_name FROM Users u1 JOIN Users u2 ON u1.manager_id = u2.user_id WHERE u1.user_id = ? AND u1.organization_id = ?',
                        [userId, organizationId]
                    );
                    
                    let managerName = "your manager";
                    if (managerInfo.length > 0) {
                        managerName = `${managerInfo[0].first_name} ${managerInfo[0].last_name}`;
                    }
                    
                    // Get updated leave balances to show in response
                    const [updatedLeaveTypes] = await dbPool.execute(
                        'SELECT leave_type, total_allotted, leaves_taken, leaves_pending_approval FROM LeaveBalances WHERE user_id = ? AND organization_id = ?', 
                        [userId, organizationId]
                    );
                    
                    // Calculate new total leaves used
                    const newTotalLeavesUsed = updatedLeaveTypes.reduce((sum, leave) => 
                        sum + leave.leaves_taken + leave.leaves_pending_approval, 0);
                    
                    const remainingLeaves = defaultAllotment - newTotalLeavesUsed;
                    
                    return {
                        statusCode: 200,
                        headers: headers,
                        body: JSON.stringify({ 
                            success: true, 
                            message: `Your ${specifiedLeaveType} application has been submitted successfully. It is now pending approval from ${managerName}. You have ${remainingLeaves} out of ${defaultAllotment} leave days remaining.`,
                            data: [{
                                leave_type: specifiedLeaveType,
                                status: 'PENDING',
                                days_requested: 1,
                                applied_on: new Date().toISOString(),
                                remaining_leaves: remainingLeaves,
                                leave_balances: updatedLeaveTypes
                            }]
                        })
                    };
                } catch (error) {
                    console.error("Error processing leave application:", error);
                    return {
                        statusCode: 500,
                        headers: headers,
                        body: JSON.stringify({ 
                            message: 'Failed to process leave application.', 
                            details: error.message,
                            stack: error.stack,
                            success: false
                        })
                    };
                }
            }
            
            // Handle leave type response after db init
            if (isLeaveTypeResponse) {
                console.log("LEAVE TYPE RESPONSE DETECTED");
                
                // Check if there's a pending leave application for this user
                try {
                    const [pendingApplications] = await dbPool.execute(
                        'SELECT * FROM PendingLeaveApplications WHERE user_id = ? AND organization_id = ? AND status = ?',
                        [userId, organizationId, 'PENDING']
                    );
                    
                    // If there's no pending application in the database but the client didn't send the flag,
                    // this might not actually be a leave application response
                    if (pendingApplications.length === 0 && body.leave_application_pending !== true) {
                        // Only treat it as a leave response if it's a very clear single-word leave type
                        if (!isSingleWordLeaveType || prompt.trim().split(' ').length > 1) {
                            console.log("No pending leave application found, treating as a regular query");
                            // This is likely just a query about leave balance, not a response to our prompt
                            isLeaveTypeResponse = false;
                        }
                    } else {
                        console.log("Found pending leave application:", pendingApplications[0]);
                    }
                } catch (error) {
                    // If we can't check the database, just rely on the client-side flag
                    console.error("Error checking pending leave applications:", error);
                }
                
                if (!isLeaveTypeResponse) {
                    // Skip this handler and continue to the next one
                    console.log("Not a leave type response after all, continuing...");
                } else {
                    let specifiedLeaveType = null;
                    if (trimmedPrompt.includes('sick')) {
                        specifiedLeaveType = 'Sick Leave';
                    } else if (trimmedPrompt.includes('casual')) {
                        specifiedLeaveType = 'Casual Leave';
                    } else if (trimmedPrompt.includes('earned')) {
                        specifiedLeaveType = 'Earned Leave';
                    }
                    
                    if (!specifiedLeaveType) {
                        return {
                            statusCode: 200,
                            headers: headers,
                            body: JSON.stringify({ 
                                success: false, 
                                message: "I couldn't understand the leave type. Please specify one of: Sick Leave, Casual Leave, or Earned Leave.",
                                data: [],
                                leave_application_pending: true
                            })
                        };
                    }
                    
                    try {
                        // Clean up the pending application
                        try {
                            await dbPool.execute(
                                'DELETE FROM PendingLeaveApplications WHERE user_id = ? AND organization_id = ?',
                                [userId, organizationId]
                            );
                        } catch (error) {
                            console.error("Error cleaning up pending application:", error);
                            // Continue even if cleanup fails
                        }
                        
                        // Check if the user has this type of leave available
                        const [leaveBalances] = await dbPool.execute(
                            'SELECT * FROM LeaveBalances WHERE user_id = ? AND organization_id = ? AND leave_type = ?', 
                            [userId, organizationId, specifiedLeaveType]
                        );
                        
                        // Get all leave types for the user to calculate total leaves used
                        const [allLeaveTypes] = await dbPool.execute(
                            'SELECT leave_type, total_allotted, leaves_taken, leaves_pending_approval FROM LeaveBalances WHERE user_id = ? AND organization_id = ?', 
                            [userId, organizationId]
                        );
                        
                        console.log("All leave types for user:", allLeaveTypes);
                        
                        // Calculate total leaves used across all leave types
                        let totalLeavesUsed = 0;
                        let defaultAllotment = 10; // Default allotment if no leave types exist
                        
                        if (allLeaveTypes.length > 0) {
                            // Sum up all leaves taken and pending
                            totalLeavesUsed = allLeaveTypes.reduce((sum, leave) => 
                                sum + leave.leaves_taken + leave.leaves_pending_approval, 0);
                            
                            // Get the total_allotted value from the first leave type
                            // This assumes all leave types have the same total_allotted value
                            defaultAllotment = allLeaveTypes[0].total_allotted;
                        }
                        
                        console.log("Total leaves used across all types:", totalLeavesUsed);
                        console.log("Default allotment:", defaultAllotment);
                        
                        // Calculate available leaves
                        const availableLeaves = defaultAllotment - totalLeavesUsed;
                        
                        if (availableLeaves <= 0) {
                            return {
                                statusCode: 200,
                                headers: headers,
                                body: JSON.stringify({ 
                                    success: false, 
                                    message: `You don't have any leave balance available. You've used ${totalLeavesUsed} out of ${defaultAllotment} total leave days.`,
                                    data: []
                                })
                            };
                        }
                        
                        // If the specified leave type doesn't exist for this user, create it
                        if (leaveBalances.length === 0) {
                            console.log(`Leave type ${specifiedLeaveType} not found for user. Creating it...`);
                            
                            // Insert the new leave type
                            await dbPool.execute(
                                'INSERT INTO LeaveBalances (organization_id, user_id, leave_type, total_allotted, leaves_taken, leaves_pending_approval, last_updated) VALUES (?, ?, ?, ?, 0, 1, NOW())',
                                [organizationId, userId, specifiedLeaveType, defaultAllotment]
                            );
                            
                            console.log(`Created new leave type ${specifiedLeaveType} for user with 1 pending approval`);
                        } else {
                            // Update leaves_pending_approval for the specified leave type
                            await dbPool.execute(
                                'UPDATE LeaveBalances SET leaves_pending_approval = leaves_pending_approval + 1, last_updated = NOW() WHERE user_id = ? AND organization_id = ? AND leave_type = ?', 
                                [userId, organizationId, specifiedLeaveType]
                            );
                            
                            console.log(`Updated leave_pending_approval for ${specifiedLeaveType}`);
                        }
                        
                        // Get manager information to include in the response
                        const [managerInfo] = await dbPool.execute(
                            'SELECT u2.first_name, u2.last_name FROM Users u1 JOIN Users u2 ON u1.manager_id = u2.user_id WHERE u1.user_id = ? AND u1.organization_id = ?',
                            [userId, organizationId]
                        );
                        
                        let managerName = "your manager";
                        if (managerInfo.length > 0) {
                            managerName = `${managerInfo[0].first_name} ${managerInfo[0].last_name}`;
                        }
                        
                        // Get updated leave balances to show in response
                        const [updatedLeaveTypes] = await dbPool.execute(
                            'SELECT leave_type, total_allotted, leaves_taken, leaves_pending_approval FROM LeaveBalances WHERE user_id = ? AND organization_id = ?', 
                            [userId, organizationId]
                        );
                        
                        // Calculate new total leaves used
                        const newTotalLeavesUsed = updatedLeaveTypes.reduce((sum, leave) => 
                            sum + leave.leaves_taken + leave.leaves_pending_approval, 0);
                        
                        const remainingLeaves = defaultAllotment - newTotalLeavesUsed;
                        
                        return {
                            statusCode: 200,
                            headers: headers,
                            body: JSON.stringify({ 
                                success: true, 
                                message: `Your ${specifiedLeaveType} application has been submitted successfully. It is now pending approval from ${managerName}. You have ${remainingLeaves} out of ${defaultAllotment} leave days remaining.`,
                                data: [{
                                    leave_type: specifiedLeaveType,
                                    status: 'PENDING',
                                    days_requested: 1,
                                    applied_on: new Date().toISOString(),
                                    remaining_leaves: remainingLeaves,
                                    leave_balances: updatedLeaveTypes
                                }]
                            })
                        };
                    } catch (error) {
                        console.error("Error processing leave application response:", error);
                        return {
                            statusCode: 500,
                            headers: headers,
                            body: JSON.stringify({ 
                                message: 'Failed to process leave application.', 
                                details: error.message,
                                stack: error.stack,
                                success: false
                            })
                        };
                    }
                }
            }

            // Directly block identity queries about others for employees
            if (userRole === 'Employee') {
                // Patterns for asking about other people's IDs
                const otherIdPatterns = [
                    /what(?:'s| is) (?!my\b)(\w+)(?:'s)? (?:id|user ?id|employee ?id)/i,
                    /(?:id|user ?id|employee ?id) (?:of|for) (?!me\b)(\w+)/i,
                    /(?:find|get|show|tell me)(?: the)? (?:id|user ?id|employee ?id) (?:of|for) (?!me\b)(\w+)/i
                ];
                
                if (otherIdPatterns.some(pattern => pattern.test(prompt))) {
                    console.error(`SECURITY: Employee ${userId} attempted to directly query another user's ID`);
                    return {
                        statusCode: 403,
                        headers: headers,
                        body: JSON.stringify({ 
                            message: 'Access denied. You can only view your own information.',
                            success: false
                        })
                    };
                }
            }
            
            // Check for write operation keywords in the prompt
            const writeOperationKeywords = [
                'update', 'change', 'modify', 'set', 'insert', 'delete', 'remove', 'add',
                'create', 'alter', 'drop', 'truncate', 'grant', 'revoke'
            ];
            
            // More sophisticated check for write operations in the prompt
            const writeOperationPatterns = [
                /\bupdate\s+\w+\s+set\b/i,
                /\binsert\s+into\b/i,
                /\bdelete\s+from\b/i,
                /\bcreate\s+table\b/i,
                /\bdrop\s+table\b/i,
                /\balter\s+table\b/i
            ];
            
            // Check for basic keywords first
            for (const keyword of writeOperationKeywords) {
                const regex = new RegExp(`\\b${keyword}\\b`, 'i');
                if (regex.test(trimmedPrompt)) {
                    console.log(`SECURITY: Detected potential write operation keyword '${keyword}' in prompt: ${prompt}`);
                    
                    // Additional context check to reduce false positives
                    // If these words appear alongside certain HR-related terms, it might be a legitimate query about changes, not an attempt to make changes
                    const hrContextWords = ['policy', 'policies', 'rule', 'rules', 'information', 'record', 'history'];
                    const hasHRContext = hrContextWords.some(word => trimmedPrompt.includes(word));
                    
                    // Check for more definitive write operation patterns
                    const hasWritePattern = writeOperationPatterns.some(pattern => pattern.test(trimmedPrompt));
                    
                    if (hasWritePattern || !hasHRContext) {
                        return {
                            statusCode: 403,
                            headers: headers,
                            body: JSON.stringify({ 
                                message: 'This system only allows viewing data. Updates must be performed through the HR department.',
                                details: 'Write operations are not permitted through this API.',
                                success: false
                            })
                        };
                    }
                    
                    // If we reach here, it was a potential false positive with HR context, so continue processing
                    console.log('Potential false positive with HR context, continuing...');
                }
            }

            const systemPrompt = await getSystemPrompt(userRole);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

            // Modify the user prompt to include explicit access control reminder
            let securePrompt = prompt;
            // Check if the prompt contains names of users other than the current user
            const userWords = userFullName.toLowerCase().split(' ');
            const promptWords = prompt.toLowerCase().split(/\s+/);
            
            // Create a logging entry for security audit
            const securityLog = {
                timestamp: new Date().toISOString(),
                userId: userId,
                organizationId: organizationId,
                userRole: userRole,
                prompt: prompt,
                potentialIssues: []
            };
            
            // Enhanced name detection - check if the prompt explicitly mentions other users' names
            // Common name patterns in queries
            const namePatterns = [
                /\b(what is|what's|who is|who's|find|get|show|tell me)\s+(\w+)(?:'s|\s+)(?:id|user id|employee id|userid)\b/i,
                /\b(\w+)(?:'s|\s+)(?:id|user id|employee id|userid)\b/i,
                /\b(id|user id|employee id|userid)(?:\s+of|\s+for)\s+(\w+)\b/i
            ];
            
            // Extract potential names from the prompt
            const potentialNames = [];
            for (const pattern of namePatterns) {
                const matches = prompt.match(pattern);
                if (matches && matches.length > 1) {
                    // The captured name should be in the second group
                    const possibleName = matches[2];
                    if (possibleName && 
                        possibleName.length > 2 && 
                        !/^(my|your|their|his|her|its)$/i.test(possibleName)) {
                        potentialNames.push(possibleName.toLowerCase());
                    }
                }
            }
            
            console.log("Potential names detected in prompt:", potentialNames);
            
            // If we found potential names and none match the current user
            if (potentialNames.length > 0 && 
                !potentialNames.some(name => userWords.includes(name))) {
                
                securityLog.potentialIssues.push(`Potential query about another user: ${potentialNames.join(', ')}`);
                
                // For employees, this is an immediate block
                if (userRole === 'Employee') {
                    console.error(`SECURITY VIOLATION: Employee ${userId} attempted to access identity data for: ${potentialNames.join(', ')}`);
                    
                    // Log the security violation
                    console.log("SECURITY AUDIT LOG:", JSON.stringify(securityLog));
                    
                    return {
                        statusCode: 403,
                        headers: headers,
                        body: JSON.stringify({ 
                            message: 'Access denied. You can only view your own information.',
                            success: false
                        })
                    };
                }
                
                // For managers, verify the name corresponds to a direct report
                if (userRole === 'Manager') {
                    // Check if these names exist in the database as direct reports
                    const nameConditions = potentialNames.map(() => 
                        'LOWER(first_name) = ? OR LOWER(last_name) = ?'
                    ).join(' OR ');
                    
                    const [possibleUsers] = await dbPool.execute(`
                        SELECT user_id, first_name, last_name 
                        FROM Users 
                        WHERE organization_id = ? AND (${nameConditions})
                    `, [organizationId, ...potentialNames.flatMap(name => [name, name])]);
                    
                    // If we found matching users, check if they're direct reports
                    if (possibleUsers.length > 0) {
                        // Get direct reports
                        const [reports] = await dbPool.execute(
                            'SELECT user_id FROM Users WHERE manager_id = ? AND organization_id = ?', 
                            [userId, organizationId]
                        );
                        
                        const directReportIds = reports.map(r => r.user_id);
                        
                        // Check if any found user is not a direct report
                        const unauthorizedAccess = possibleUsers.some(user => 
                            !directReportIds.includes(user.user_id)
                        );
                        
                        if (unauthorizedAccess) {
                            console.error(`SECURITY VIOLATION: Manager ${userId} attempted to access non-direct report identity data`);
                            securityLog.potentialIssues.push('Manager accessing non-direct report identity');
                            
                            // Log the security violation
                            console.log("SECURITY AUDIT LOG:", JSON.stringify(securityLog));
                            
                            return {
                                statusCode: 403,
                                headers: headers,
                                body: JSON.stringify({ 
                                    message: 'Access denied. You can only view information for yourself and your direct reports.',
                                    success: false
                                })
                            };
                        }
                    }
                }
            }
            
            // Look for common patterns of trying to bypass security
            const securityKeywords = ['bypass', 'ignore', 'admin', 'override', 'all users', 'everyone'];
            const hasSuspiciousKeywords = securityKeywords.some(keyword => 
                prompt.toLowerCase().includes(keyword)
            );
            
            if (hasSuspiciousKeywords) {
                securityLog.potentialIssues.push('Suspicious keywords detected');
                console.warn(`SECURITY WARNING: Suspicious keywords detected in prompt: ${prompt}`);
            }
            
            // Check for attempts to access all data
            if (prompt.toLowerCase().includes('all') && 
                (prompt.toLowerCase().includes('employees') || 
                 prompt.toLowerCase().includes('users') || 
                 prompt.toLowerCase().includes('salaries'))) {
                securityLog.potentialIssues.push('Possible attempt to access bulk data');
                console.warn(`SECURITY WARNING: Possible attempt to access bulk data: ${prompt}`);
                
                if (userRole !== 'Admin') {
                    return {
                        statusCode: 403,
                        headers: headers,
                        body: JSON.stringify({ 
                            message: 'Access denied. You do not have permission to access bulk data.',
                            success: false
                        })
                    };
                }
            }
            
            // For employee role, add strong warning about only accessing own data
            if (userRole === 'Employee') {
                // Check if the prompt mentions any potential person other than themselves
                const containsOtherNames = promptWords.some(word => 
                    word.length > 3 && // Only consider words with more than 3 chars to avoid common words
                    !userWords.includes(word) && 
                    /^[A-Za-z]+$/.test(word) && // Only alphabetical words
                    word[0].toUpperCase() === word[0] // First letter is uppercase (likely a name)
                );
                
                if (containsOtherNames) {
                    console.log("WARNING: Employee possibly trying to access another user's data. Adding strict reminder.");
                    securityLog.potentialIssues.push('Employee attempting to access another user data');
                    securePrompt = `REMINDER: I can only access my own data as an employee. ${prompt}`;
                    
                    // Extract potential name from the prompt
                    const potentialNames = promptWords.filter(word => 
                        word.length > 3 && 
                        !userWords.includes(word) && 
                        /^[A-Za-z]+$/.test(word) && 
                        word[0].toUpperCase() === word[0]
                    );
                    
                    if (potentialNames.length > 0) {
                        // Check if these names exist in the database
                        const [users] = await dbPool.execute(`
                            SELECT user_id, first_name, last_name 
                            FROM Users 
                            WHERE organization_id = ? AND
                            (${potentialNames.map(() => 'LOWER(first_name) = ? OR LOWER(last_name) = ?').join(' OR ')})
                        `, [organizationId, ...potentialNames.flatMap(name => [name.toLowerCase(), name.toLowerCase()])]);
                        
                        if (users.length > 0) {
                            console.error(`SECURITY VIOLATION: Employee ${userId} attempted to access data for: ${users.map(u => u.user_id).join(', ')}`);
                            securityLog.potentialIssues.push(`Confirmed attempt to access: ${users.map(u => u.user_id).join(', ')}`);
                            
                            // Log the security violation
                            console.log("SECURITY AUDIT LOG:", JSON.stringify(securityLog));
                            
                            // Return access denied for confirmed violation
                            return {
                                statusCode: 403,
                                headers: headers,
                                body: JSON.stringify({ 
                                    message: 'Access denied. You can only view your own information.',
                                    success: false
                                })
                            };
                        }
                    }
                }
            }
            
            // For managers, remind about scope limitations
            if (userRole === 'Manager') {
                securePrompt = `REMINDER: As a manager, I can only access my own data and data for my direct reports. ${prompt}`;
            }
            
            // Log all sensitive access attempts
            if (securityLog.potentialIssues.length > 0) {
                console.log("SECURITY AUDIT LOG:", JSON.stringify(securityLog));
            }

            const fullPrompt = `User's question: "${securePrompt}"\nMy user_id is: "${userId}"\nMy full name is: "${userFullName}"\nMy organization_id is: "${organizationId}"\nMy role is: "${userRole}"`;

            const result = await model.generateContent([systemPrompt, fullPrompt]);
            const response = await result.response;
            let responseText = response.text().trim();

            // Robustly extract JSON from markdown block if present
            const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
            if (jsonMatch) {
                responseText = jsonMatch[1].trim();
            }

            // The AI should now return JSON
            let parsedResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (e) {
                console.error("Failed to parse JSON response from AI:", responseText);
                return {
                    statusCode: 500,
                    headers: headers,
                    body: JSON.stringify({ message: "Received an invalid response from the AI model.", success: false })
                };
            }

            let { sql: generatedSql, confirmation_message: confirmationMessage } = parsedResponse;
            
            console.log("Cleaned SQL:", generatedSql);

            if (generatedSql.toUpperCase() === 'MULTI_ACTION_ERROR') {
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ message: confirmationMessage || "The request involves multiple actions. Please send separate prompts.", success: false })
                };
            }

            if (generatedSql.toUpperCase() === 'IRRELEVANT') {
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ message: confirmationMessage || "This question is not relevant to HR data.", success: false })
                };
            }

            if (generatedSql.toUpperCase() === 'ACCESS_DENIED') {
                return {
                    statusCode: 403,
                    headers: headers,
                    body: JSON.stringify({ message: confirmationMessage || "Access denied.", success: false })
                };
            }

            if (generatedSql.toUpperCase() === 'AMBIGUOUS_QUERY') {
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ message: confirmationMessage || "The query is ambiguous. Please provide more specific details.", success: false })
                };
            }

            if (!isQuerySafe(generatedSql)) {
                return {
                    statusCode: 403,
                    headers: headers,
                    body: JSON.stringify({ message: 'Generated query is not allowed for security reasons.', success: false })
                };
            }
            
            // Additional validation to enforce access controls
            const validateAccessControl = async (sql, userId, userRole, organizationId) => {
                const upperSql = sql.toUpperCase();
                console.log("Validating SQL:", sql);
                
                // Add special allowlist for common salary and HR data queries
                const salaryPatterns = [
                    /SELECT.*\b(?:base_salary|salary|HRA|conveyance_allowance|medical_allowance|ctc)\b.*\bFROM\s+PayrollData\b/i,
                    /SELECT.*\bFROM\s+PayrollData\b/i,
                    /SELECT.*\bleave.*balance\b.*\bFROM\s+LeaveBalances\b/i,
                    /SELECT.*\bFROM\s+LeaveBalances\b/i,
                    /SELECT.*\bFROM\s+CompanyPolicies\b/i
                ];
                
                // Check if this is a salary or leave query
                const isSalaryQuery = salaryPatterns.some(pattern => pattern.test(sql));
                
                if (isSalaryQuery) {
                    console.log("Salary/Leave query detected, applying specific validation");
                    
                    // For Employees, salary queries must reference their own user_id
                    if (userRole === 'Employee') {
                        // Must contain their own user_id somewhere in the query
                        const hasOwnId = sql.includes(userId) || 
                                     upperSql.includes(userId.toUpperCase()) ||
                                     (upperSql.includes('USER_ID') && upperSql.includes('?'));
                                     
                        if (!hasOwnId) {
                            console.error("SECURITY: Employee salary query without proper user_id restriction");
                            return false;
                        }
                        
                        // Check if attempting to access someone else's salary
                        const otherUserIdPattern = /USER_ID\s*=\s*['"]([^'"]+)['"]/i;
                        const otherUserIdMatch = upperSql.match(otherUserIdPattern);
                        
                        if (otherUserIdMatch && otherUserIdMatch[1] !== userId.toUpperCase()) {
                            console.error("SECURITY: Employee attempting to access another user's salary data");
                            return false;
                        }
                        
                        return true;
                    }
                    
                    // For Managers, they can see their data and direct reports
                    if (userRole === 'Manager') {
                        const otherUserIdMatch = upperSql.match(/USER_ID\s*=\s*['"]([^'"]+)['"]/i);
                        if (otherUserIdMatch && otherUserIdMatch[1] !== userId.toUpperCase()) {
                            // Verify it's a direct report
                            const [reports] = await dbPool.execute(
                                'SELECT user_id FROM Users WHERE manager_id = ? AND organization_id = ?', 
                                [userId, organizationId]
                            );
                            
                            const directReports = reports.map(r => r.user_id.toUpperCase());
                            if (!directReports.includes(otherUserIdMatch[1])) {
                                console.error(`SECURITY: Manager attempting to access non-direct report salary`);
                                return false;
                            }
                        }
                        
                        return true;
                    }
                    
                    // For Admins, they can see all salary data within their organization
                    if (userRole === 'Admin') {
                        // Just need to make sure it's scoped to their organization
                        return sql.includes(organizationId) || 
                               upperSql.includes(organizationId.toUpperCase()) ||
                               upperSql.includes('ORGANIZATION_ID');
                    }
                }
                
                // Block specific queries about other users' IDs for employees
                if (userRole === 'Employee') {
                    // This pattern would catch queries that select user_id from Users where conditions mention first_name or last_name
                    const idLookupByNamePattern = /SELECT\b.*\buser_id\b.*\bFROM\s+Users\b.*\bWHERE\b.*\b(first_name|last_name)\b/i;
                    
                    if (idLookupByNamePattern.test(sql)) {
                        console.error("SECURITY BLOCK: Employee attempting to look up user_id by name");
                        return false;
                    }
                    
                    // Detect queries returning all user IDs
                    const allUsersPattern = /SELECT\b.*\buser_id\b.*\bFROM\s+Users\b.*(?:\bWHERE\b.*\borgamization_id\b|\bWHERE\b.*\bdepartment\b|\bWHERE\b.*\blocation\b)/i;
                    
                    if (allUsersPattern.test(sql) && !sql.includes(userId)) {
                        console.error("SECURITY BLOCK: Employee attempting to retrieve multiple user IDs");
                        return false;
                    }
                }
                
                // Special allowlist for identity and basic profile queries that should always be allowed
                const identityPatterns = [
                    /SELECT\s+user_id\s+FROM\s+Users\s+WHERE\s+user_id\s*=\s*/i,
                    /SELECT.*\buser_id\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\bfirst_name\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\blast_name\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\brole\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\bemail\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\bdepartment\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\bdate_of_joining\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\bmanager_id\b.*\bFROM\s+Users\b/i,
                    /SELECT.*\blocation\b.*\bFROM\s+Users\b/i
                ];
                
                // Check if this is a basic identity/profile query
                const isIdentityQuery = identityPatterns.some(pattern => pattern.test(sql));
                
                // For identity queries, only check that they include the user's ID or organization ID
                if (isIdentityQuery) {
                    console.log("Identity query detected, applying simplified validation");
                    
                    // For Employees, identity queries must explicitly reference their own ID
                    if (userRole === 'Employee') {
                        // Must contain their own user_id in the WHERE clause
                        if (!upperSql.includes(`WHERE`) || !sql.includes(userId)) {
                            console.error("SECURITY: Employee identity query without proper user_id restriction");
                            return false;
                        }
                        return true;
                    }
                    
                    // For identity queries, only ensure they reference the current user or organization
                    if (sql.includes(userId) || upperSql.includes(userId.toUpperCase())) {
                        return true;
                    }
                    
                    if (sql.includes(organizationId) || upperSql.includes(organizationId.toUpperCase())) {
                        // If query contains organization ID but not user ID, check if it contains WHERE clauses
                        // that might retrieve multiple users
                        if (!sql.includes("WHERE") || sql.includes("WHERE 1=1")) {
                            console.error("SECURITY: Identity query with no proper filtering");
                            return false;
                        }
                        return true;
                    }
                }
                
                // Extract table names and condition clauses for validation
                const fromMatch = upperSql.match(/\bFROM\s+([^\s,;()]+)/i);
                const whereMatch = upperSql.match(/\bWHERE\s+(.*?)(?:\bGROUP BY|\bORDER BY|\bLIMIT|\bHAVING|$)/is);
                
                if (!fromMatch) {
                    console.error("SECURITY: Cannot validate query without FROM clause");
                    return false;
                }
                
                const mainTable = fromMatch[1].trim();
                console.log(`Validating access control for table: ${mainTable}`);
                
                // Check for name-based queries which might bypass ID-based restrictions
                // This detects patterns like "WHERE first_name = 'Amit'" or "WHERE last_name = 'Kumar'"
                const nameBasedQuery = /WHERE\s+(?:.*(?:AND|OR)\s+)?(?:first_name|last_name)\s*=\s*['"][^'"]+['"]/.test(upperSql);
                
                if (nameBasedQuery && userRole !== 'Admin') {
                    console.error("SECURITY: Detected potential name-based query that might bypass ID restrictions");
                    
                    // If it's a name-based query, verify that any names mentioned correspond to authorized users
                    const [userNames] = await dbPool.execute(`
                        SELECT user_id, CONCAT(first_name, ' ', last_name) as full_name, first_name, last_name 
                        FROM Users 
                        WHERE organization_id = ?
                    `, [organizationId]);
                    
                    // Extract potential name patterns from the query
                    const namePatterns = upperSql.match(/(?:first_name|last_name)\s*=\s*['"]([^'"]+)['"]/ig);
                    if (namePatterns) {
                        // Extract just the name values from the patterns
                        const extractedNames = namePatterns.map(pattern => {
                            const match = pattern.match(/['"]([^'"]+)['"]/);
                            return match ? match[1].toUpperCase() : null;
                        }).filter(Boolean);
                        
                        if (extractedNames.length > 0) {
                            // Check if any extracted name is not the current user and not a direct report (for managers)
                            const authorizedUserIds = [userId];
                            
                            // For managers, add their direct reports
                            if (userRole === 'Manager') {
                                const [reports] = await dbPool.execute(
                                    'SELECT user_id FROM Users WHERE manager_id = ? AND organization_id = ?', 
                                    [userId, organizationId]
                                );
                                authorizedUserIds.push(...reports.map(r => r.user_id));
                            }
                            
                            // Get all authorized users' details
                            const [authorizedUsers] = await dbPool.execute(`
                                SELECT user_id, first_name, last_name 
                                FROM Users 
                                WHERE user_id IN (?) AND organization_id = ?
                            `, [authorizedUserIds, organizationId]);
                            
                            // Check if any extracted name belongs to an unauthorized user
                            let unauthorized = false;
                            for (const name of extractedNames) {
                                const nameMatchesAuthorizedUser = authorizedUsers.some(user => 
                                    user.first_name.toUpperCase() === name || 
                                    user.last_name.toUpperCase() === name
                                );
                                
                                if (!nameMatchesAuthorizedUser) {
                                    console.error(`SECURITY: Name "${name}" in query does not match any authorized user`);
                                    unauthorized = true;
                                    break;
                                }
                            }
                            
                            if (unauthorized) {
                                return false;
                            }
                        }
                    }
                }
                
                // More flexible organization_id check
                const hasOrgId = sql.includes(organizationId) || 
                                upperSql.includes(organizationId.toUpperCase()) ||
                                upperSql.includes(`ORGANIZATION_ID`) || 
                                sql.includes(`organization_id`);
                                
                if (!hasOrgId) {
                    console.error("SECURITY: Query doesn't properly scope to organization_id");
                    return false;
                }
                
                // Employee role - can only see their own data
                if (userRole === 'Employee') {
                    const hasUserId = sql.includes(userId) || 
                                    upperSql.includes(userId.toUpperCase()) ||
                                    upperSql.includes(`USER_ID = ?`) ||
                                    sql.includes(`user_id = ?`);
                                    
                    if (!hasUserId) {
                        // Check for indirect joins that might still filter by user_id
                        if (!upperSql.includes('JOIN') || !sql.includes(userId)) {
                            console.error("SECURITY: Employee attempting to access other users' data");
                            return false;
                        }
                    }
                }
                
                // Manager role - can see their data and direct reports
                if (userRole === 'Manager') {
                    // If query includes user_id but it's not the manager's ID, verify it's a direct report
                    const otherUserIdMatch = upperSql.match(/USER_ID\s*=\s*['"]([^'"]+)['"]/i);
                    if (otherUserIdMatch && otherUserIdMatch[1] !== userId.toUpperCase()) {
                        const targetUserId = otherUserIdMatch[1];
                        
                        // Verify management relationship
                        const [reports] = await dbPool.execute(
                            'SELECT user_id FROM Users WHERE manager_id = ? AND organization_id = ?', 
                            [userId, organizationId]
                        );
                        
                        const directReports = reports.map(r => r.user_id.toUpperCase());
                        if (!directReports.includes(targetUserId)) {
                            console.error(`SECURITY: Manager attempting to access non-direct report (${targetUserId})`);
                            return false;
                        }
                    }
                }
                
                return true;
            };
            
            // Remove trailing semicolon if exists
            if (generatedSql.endsWith(';')) {
                generatedSql = generatedSql.slice(0, -1);
            }
            
            // Validate access control before executing
            const accessControlValid = await validateAccessControl(generatedSql, userId, userRole, organizationId);
            if (!accessControlValid) {
                return {
                    statusCode: 403,
                    headers: headers,
                    body: JSON.stringify({ 
                        message: "Access denied. You do not have permission to view this data.",
                        details: "The request violates access control policies.", 
                        success: false 
                    })
                };
            }

            const [queryResult] = await dbPool.execute(generatedSql);

            // For SELECT, result is an array of rows. For others, it's an info object.
            if (Array.isArray(queryResult)) {
                // Check if data was found
                if (queryResult.length === 0) {
                    // No data found, provide natural language response
                    let noDataMessage;
                    if (trimmedPrompt.includes('salary')) {
                        noDataMessage = "Sorry, I couldn't find any salary information for you in our records.";
                    } else if (trimmedPrompt.includes('leave')) {
                        noDataMessage = "Sorry, I couldn't find any leave information for you in our records.";
                    } else if (trimmedPrompt.includes('attendance')) {
                        noDataMessage = "Sorry, I couldn't find any attendance records for you.";
                    } else {
                        noDataMessage = "Sorry, I couldn't find any data matching your request.";
                    }
                    
                    return {
                        statusCode: 200,
                        headers: headers,
                        body: JSON.stringify({ success: true, message: noDataMessage, data: [] })
                    };
                }
                
                // Data found, use the original confirmation message
                return {
                    statusCode: 200,
                    headers: headers,
                    body: JSON.stringify({ success: true, message: confirmationMessage, data: queryResult })
                };
            }

            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({ success: true, message: confirmationMessage, details: queryResult })
            };

        } catch (error) {
            console.error('Error processing AI query:', error);
            return {
                statusCode: 500,
                headers: headers,
                body: JSON.stringify({ 
                    message: 'Failed to process AI query.', 
                    details: error.message,
                    stack: error.stack,
                    success: false
                })
            };
        }
    }

    // Handle /api endpoint with extreme flexibility
    if (path === '/api' || path === '/api/' || lastPathPart === 'api' || path.includes('/api') || basePath === 'api') {
        console.log('API ROOT ENDPOINT MATCHED');
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                message: "Welcome to the Vipra HR API",
                endpoints: ["ai-query", "debug"],
                success: true
            })
        };
    }
    
    // Special handler for paths coming from router with '/user/' pattern
    if (path.includes('/user/')) {
        console.log('USER PREFIX DETECTED');
        // Extract the part after /user/
        const afterUserPath = path.split('/user/')[1];
        console.log('After user path:', afterUserPath);
        
        if (afterUserPath === 'ai-query' || afterUserPath.includes('ai-query')) {
            console.log('ROUTING TO AI-QUERY FROM USER PATH');
            // This is a request for ai-query coming through the user route
            try {
                // Get the request body
                let body = {};
                if (event.body) {
                    body = JSON.parse(event.body);
                }
                
                const prompt = body.prompt;
                const userId = event.headers['x-user-id'] || event.headers['X-User-Id'];
                const organizationId = event.headers['x-organization-id'] || event.headers['X-Organization-Id'];
    
                if (!prompt || !userId || !organizationId) {
                    return {
                        statusCode: 400,
                        headers: headers,
                        body: JSON.stringify({ message: 'Missing prompt, x-user-id, or x-organization-id in request', success: false })
                    };
                }
                
                // Use the same AI query handling logic...
                // (you would copy the rest of the AI query logic here, but for brevity,
                // we'll return a simple success message for testing)
                return {
                    statusCode: 200,
                    headers: headers,
                    body: JSON.stringify({ 
                        success: true, 
                        message: "This is a placeholder response from the /user/ai-query endpoint handler",
                        data: []
                    })
                };
            } catch (error) {
                console.error('Error processing user AI query:', error);
                return {
                    statusCode: 500,
                    headers: headers,
                    body: JSON.stringify({ 
                        message: 'Failed to process user AI query.', 
                        details: error.message,
                        stack: error.stack,
                        success: false
                    })
                };
            }
        }
    }
    
    // Default response for any other path
    return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ 
            message: "Not Found from simple handler",
            path: path,
            method: method,
            success: false
        }),
    };
}; 