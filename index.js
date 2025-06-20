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
            roleBasedInstructions = `6. **Strict Data Scoping**: The user is an 'Employee'. ALL generated SQL queries MUST be strictly scoped to the user's own 'user_id'. The query must include a 'WHERE' clause filtering by the 'user_id' provided in the prompt (e.g., 'WHERE user_id = "THE_USER_ID"'). Do not use the user's name (e.g., "Rahul Verma") for filtering; always use the 'user_id'. If the user asks about another person, you MUST refuse. For such cases, set "sql" to "ACCESS_DENIED" and "confirmation_message" to "Access Denied: You can only view your own information."`;
        } else if (userRole === 'Manager') {
            roleBasedInstructions = `6. **Manager Data Scoping**: The user is a 'Manager'. They can view their own data and the data of employees who report directly to them (whose 'manager_id' is the manager's 'user_id'). For queries about other employees, you must first verify this relationship. If the request is for an employee not under their management, or for another manager, treat it as an access denial. For such cases, set "sql" to "ACCESS_DENIED" and "confirmation_message" to "Access Denied: You can only view information for yourself or your direct reports." When querying for direct reports, the SQL should look like '... WHERE manager_id = "THE_MANAGER_USER_ID"'.`;
        } else if (userRole === 'Admin') {
            roleBasedInstructions = `6. **Admin Data Scoping**: The user is an 'Admin'. They can view data for ANY user within their 'organization_id'. All queries should still be scoped by the 'organization_id' provided in the prompt.`;
        }
        
        const nameMappingRule = `7. **Name-to-ID Mapping**: The user's full name is provided in the prompt. If the user's question refers to their own name (e.g., "What is Amit Kumar's leave balance?" when the user's name is Amit Kumar), treat this as a query for their own data. The SQL query MUST use the 'user_id' provided in the prompt for filtering, not the name.`;
        
        const ambiguityRule = `8. **Handle Ambiguity**: If a query refers to a name that is not unique within the user's permitted scope (e.g., a manager has two reports named 'Amit'), do not generate SQL. Set "sql" to "AMBIGUOUS_QUERY" and for the "confirmation_message", ask the user to clarify by providing a last name or employee ID. Example: "There are multiple users named Amit. Please provide a last name or a unique ID."`;

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
        'CREATE', 'RENAME', 'SHUTDOWN'
    ];
    
    // Check for semicolon to prevent multiple statements
    if (upperSql.split(';').length > 2) { // allow one semicolon at the end
        console.log("SECURITY BLOCK: Multiple statements detected");
        return false;
    }

    for (const keyword of unsafeKeywords) {
        if (upperSql.includes(keyword)) {
            console.log(`SECURITY BLOCK: Unsafe keyword '${keyword}' detected`);
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

            // Check for write operation keywords in the prompt
            const writeOperationKeywords = ['update', 'change', 'modify', 'set', 'insert', 'delete', 'remove', 'add'];
            
            for (const keyword of writeOperationKeywords) {
                if (trimmedPrompt.includes(keyword)) {
                    console.log(`SECURITY: Detected potential write operation keyword '${keyword}' in prompt: ${prompt}`);
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
            }

            // LAZY INITIALIZATION: Create clients on first request.
            if (!dbPool) {
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
            
            const systemPrompt = await getSystemPrompt(userRole);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

            const fullPrompt = `User's question: "${prompt}"\nMy user_id is: "${userId}"\nMy full name is: "${userFullName}"\nMy organization_id is: "${organizationId}"\nMy role is: "${userRole}"`;

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
            
            // Remove trailing semicolon if exists
            if (generatedSql.endsWith(';')) {
                generatedSql = generatedSql.slice(0, -1);
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