require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// Database connection pool
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Email transporter configuration
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Helper Functions ---

async function getSystemPrompt() {
    try {
        const schema = await fs.readFile('schema.txt', 'utf-8');
        const sample = await fs.readFile('sampledata.txt', 'utf-8');
        const exampleQueries = await fs.readFile('example queries.txt', 'utf-8');

        return `You are an expert SQL writer and a friendly, conversational AI assistant for a company named "Vipraco".
Your role is to act as a helpful HR assistant. Your responses should be professional yet warm and reassuring. Always end your confirmation message with a helpful next-step question, like "How can I help you further?" or "Is there anything else you need assistance with today?".

**Output Format:**
Your entire output MUST be a single JSON object. This object must have two keys:
1. "sql": A string containing the single, executable SQL query.
2. "confirmation_message": A user-friendly, natural-language string confirming what action was taken. This message should sound like a helpful human assistant. For example, instead of just "Salary updated.", say "Of course! I've just updated Rahul Verma's base salary to 50,000. Is there anything else I can help with?".

**Constraints & Rules:**
1.  **Security First**: The "sql" value MUST NOT contain any query that modifies the database schema (e.g., DROP, ALTER, TRUNCATE) or deletes data (e.g., DELETE). You are only allowed to generate SELECT, INSERT, or UPDATE queries.
2.  **Single Action**: You can only perform one action (one SQL query) per prompt. 
3.  **Multi-Action Detection**: If the user asks to do multiple distinct actions (e.g., "update salary AND update leaves"), you MUST NOT generate SQL. Instead, set the "sql" value to "MULTI_ACTION_ERROR" and the "confirmation_message" to "I can only handle one request at a time. Please try asking to 'update salary' or 'update leaves' separately."
4.  **Context is Key**: Use the provided database schema and sample data to understand the table structure and find the correct IDs for users like 'Amit' or 'Geeta'. The user's 'organization_id' and 'user_id' will be provided in the prompt for context.
5.  **Relevance**: If a question is unrelated to the HR schema (e.g., "What is the capital of France?"), you must not generate SQL. Set the "sql" value to "IRRELEVANT". For the "confirmation_message", provide a helpful response that politely declines the off-topic question. For example: "I am Vipraco's HR assistant and can only help with questions about employee data, leave, payroll, and company policies. How can I assist you with an HR-related query today?"
6.  **Precise User Identification**: When updating or querying data for a specific user mentioned by name (e.g., "Ananya", "Rahul"), always include the full WHERE clause with both first_name and organization_id. For example, use "WHERE first_name = 'Ananya' AND organization_id = 'TECHCORP_IN'" instead of just "WHERE first_name = 'Ananya'".
7.  **MySQL Syntax**: Use correct MySQL syntax for joins. For UPDATE queries with joins, use "UPDATE table1 INNER JOIN table2 ON table1.col = table2.col SET table1.col = value WHERE conditions". Do NOT use "UPDATE table1 SET col = value FROM table2" as this syntax is not supported in MySQL.
8.  **Required Fields**: When inserting data, always include ALL required fields. For PayrollData, you must include: organization_id, user_id, base_salary, and ctc. For example, when inserting salary data, always calculate and include the ctc (Cost to Company) value.
9.  **Prefer Update Over Insert**: For salary operations, prefer UPDATE over INSERT if the record likely exists. Only use INSERT when explicitly told to create a new record.
10. **STRICT Organization Access Control**: Users can ONLY access data from their own organization. ALWAYS include the organization_id in WHERE clauses for all queries. The organization_id will be provided in the prompt context. NEVER generate a query that could access data from other organizations. If a user asks about someone from another organization (like asking about "Geeta" when they're from TECHCORP_IN), set the "sql" value to "CROSS_ORG_ACCESS" and set the "confirmation_message" to "I'm sorry, but you don't have permission to access information about employees from other organizations."
11. **Leave Approval for Admins**: Admins can view all pending leave requests within their organization and approve or reject them. When approving a leave, update the leaves_taken count and reset the leaves_pending_approval to 0. When rejecting a leave, just reset the leaves_pending_approval to 0 without changing leaves_taken. Email notifications will be automatically sent to employees when their leave requests are approved or rejected.

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

**Example SQL Queries:**
1. Query: "What is Ananya's salary?"
   SQL: "SELECT pd.base_salary FROM PayrollData pd INNER JOIN Users u ON pd.user_id = u.user_id WHERE u.first_name = 'Ananya' AND u.organization_id = 'TECHCORP_IN'"
   Confirmation: "I've looked up the salary for Ananya. What else can I help you with?"

2. Query: "Set Ananya's salary to 30000"
   SQL: "UPDATE PayrollData pd INNER JOIN Users u ON pd.user_id = u.user_id SET pd.base_salary = 30000 WHERE u.first_name = 'Ananya' AND u.organization_id = 'TECHCORP_IN'"
   Confirmation: "Of course! I've just updated Ananya's base salary to 30,000. Is there anything else you need?"

3. Query: "What is Rahul's department?"
   SQL: "SELECT department FROM Users WHERE first_name = 'Rahul' AND organization_id = 'TECHCORP_IN'"
   Confirmation: "I've found that for you. Rahul is in the Engineering department. Can I help with anything else?"

4. Query: "Create a new salary record for Ananya with base salary 30000"
   SQL: "INSERT INTO PayrollData (organization_id, user_id, base_salary, HRA, conveyance_allowance, medical_allowance, pf_deduction, esi_deduction, professional_tax, ctc) SELECT 'TECHCORP_IN', user_id, 30000, 15000, 3000, 1000, 3600, 0, 200, 55000 FROM Users WHERE first_name = 'Ananya' AND organization_id = 'TECHCORP_IN'"
   Confirmation: "All set. I've created a new payroll record for Ananya with a base salary of 30,000. How can I help you further?"
   
5. Query: "Show me all employees"
   SQL: "SELECT * FROM Users WHERE organization_id = 'TECHCORP_IN'"
   Confirmation: "Here is a list of all employees in your organization. Let me know if you need more details on any of them!"
   
6. Query: "What is Geeta's user ID?" (when asked by TECHCORP_IN admin)
   Response: "CROSS_ORG_ACCESS" with message "I'm sorry, but you don't have permission to access information about employees from other organizations."

7. Query: "Show me all pending leave requests"
   SQL: "SELECT u.user_id, u.first_name, u.last_name, u.department, lb.leave_type, lb.leaves_pending_approval FROM LeaveBalances lb INNER JOIN Users u ON lb.user_id = u.user_id WHERE lb.leaves_pending_approval > 0 AND lb.organization_id = 'TECHCORP_IN' ORDER BY u.department, u.first_name"
   Confirmation: "Here are all the pending leave requests for your organization. You can approve or reject them by name."
   
8. Query: "Approve Rahul's earned leave"
   SQL: "UPDATE LeaveBalances lb INNER JOIN Users u ON lb.user_id = u.user_id SET lb.leaves_taken = lb.leaves_taken + lb.leaves_pending_approval, lb.leaves_pending_approval = 0, lb.last_updated = NOW() WHERE u.first_name = 'Rahul' AND lb.leave_type = 'Earned Leave' AND u.organization_id = 'TECHCORP_IN'"
   Confirmation: "Done! I've approved Rahul's request for Earned Leave. An email notification will be sent to him shortly. What's next?"
   
9. Query: "Reject leave request for Amit"
    SQL: "UPDATE LeaveBalances lb INNER JOIN Users u ON lb.user_id = u.user_id SET lb.leaves_pending_approval = 0, lb.last_updated = NOW() WHERE u.first_name = 'Amit' AND lb.leaves_pending_approval > 0 AND u.organization_id = 'TECHCORP_IN'"
    Confirmation: "Okay, I have rejected Amit's leave request. An email notification has been sent. Can I help with another request?"
`;
    } catch (error) {
        console.error("Error reading context files:", error);
        throw new Error("Could not build system prompt.");
    }
}

function isQuerySafe(sql) {
    const unsafeKeywords = [
        'DROP', 'TRUNCATE', 'ALTER', 'DELETE',
        'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK',
        'CREATE', 'RENAME', 'SHUTDOWN'
    ];
    const upperSql = sql.toUpperCase();
    
    // Check for semicolon to prevent multiple statements
    if (upperSql.split(';').length > 2) { // allow one semicolon at the end
        return false;
    }

    for (const keyword of unsafeKeywords) {
        if (upperSql.includes(keyword)) {
            return false;
        }
    }

    return true;
}

// Helper function to log SQL queries with detailed information
function logSqlQuery(sql, prompt, result) {
    console.log('\n==== SQL QUERY EXECUTION ====');
    console.log(`Prompt: "${prompt}"`);
    console.log(`SQL: ${sql}`);
    console.log('Result:', JSON.stringify(result, null, 2));
    console.log('============================\n');
}

// Helper function to fix common SQL syntax errors
function fixSqlSyntax(sql) {
    let fixedSql = sql;
    
    // Fix 1: Detect and fix "UPDATE ... FROM" syntax which is not supported in MySQL
    // Pattern: UPDATE table1 SET col = value FROM table2 WHERE conditions
    const updateFromPattern = /UPDATE\s+(\w+)\s+SET\s+(.+?)\s+FROM\s+(\w+)\s+WHERE\s+(.+)/i;
    if (updateFromPattern.test(fixedSql)) {
        const matches = fixedSql.match(updateFromPattern);
        if (matches && matches.length >= 5) {
            const table1 = matches[1];
            const setClause = matches[2];
            const table2 = matches[3];
            const whereClause = matches[4];
            
            // Extract the join condition from the WHERE clause
            // This is a simplification - in real scenarios, parsing the WHERE clause would be more complex
            const joinConditionPattern = new RegExp(`${table1}\\.([\\w_]+)\\s*=\\s*${table2}\\.([\\w_]+)`, 'i');
            const joinConditionMatch = whereClause.match(joinConditionPattern);
            
            if (joinConditionMatch) {
                const table1Col = joinConditionMatch[1];
                const table2Col = joinConditionMatch[2];
                
                // Remove the join condition from the WHERE clause
                const newWhereClause = whereClause.replace(joinConditionPattern, '').replace(/^\s*AND\s+|\s+AND\s*$/i, '');
                
                // Construct the correct MySQL JOIN syntax
                fixedSql = `UPDATE ${table1} INNER JOIN ${table2} ON ${table1}.${table1Col} = ${table2}.${table2Col} SET ${setClause} WHERE ${newWhereClause}`;
                console.log('Fixed SQL syntax:', fixedSql);
            }
        }
    }
    
    return fixedSql;
}

// Function to check if a query is trying to access data from another organization
async function validateCrossOrgAccess(sql, organizationId) {
    // Check if the query contains a name filter
    const nameRegex = /first_name\s*=\s*['"]([^'"]+)['"]/i;
    const nameMatch = sql.match(nameRegex);
    
    if (!nameMatch) {
        // No specific name in the query, so no cross-org validation needed
        return { valid: true };
    }
    
    const firstName = nameMatch[1];
    
    // Query to check if this user exists in a different organization
    const checkQuery = `
        SELECT organization_id FROM Users 
        WHERE first_name = ? 
        AND organization_id != ?
    `;
    
    try {
        const [results] = await dbPool.execute(checkQuery, [firstName, organizationId]);
        
        if (results.length > 0) {
            // Found a user with this name in another organization
            return {
                valid: false,
                message: `You don't have access to information about '${firstName}' as they belong to a different organization.`
            };
        }
        
        // User either doesn't exist or is in the current organization
        return { valid: true };
    } catch (error) {
        console.error('Error validating cross-organization access:', error);
        // In case of error, we'll default to allow the query
        return { valid: true };
    }
}

// Helper function to handle database errors and provide user-friendly messages
function handleDatabaseError(error, sql) {
    console.error('Database error:', error);
    
    // Create a default error response
    const errorResponse = {
        error: "There was an error executing the database query.",
        details: error.message,
        sql: sql
    };
    
    // Check for specific error types and provide more helpful messages
    if (error.code === 'ER_NO_DEFAULT_FOR_FIELD') {
        // Missing required field in an INSERT operation
        const fieldMatch = error.message.match(/Field '(\w+)' doesn't have a default value/i);
        if (fieldMatch && fieldMatch[1]) {
            const fieldName = fieldMatch[1];
            
            // Determine which table the field belongs to
            errorResponse.message = `Missing required field: ${fieldName}. Please provide this value.`;
        }
    } else if (error.code === 'ER_DUP_ENTRY') {
        // Duplicate entry error
        errorResponse.message = "This record already exists. Please update the existing record instead.";
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
        // Foreign key constraint error
        errorResponse.message = "The referenced record does not exist. Please check your input values.";
    } else {
        // Generic user-friendly message for other errors
        errorResponse.message = "I encountered an issue with the database. Please try again or rephrase your request.";
    }
    
    return errorResponse;
}

// Helper function to send email notifications for leave request approvals/rejections
async function sendLeaveNotificationEmail(userId, action, leaveType) {
    console.log(`Attempting to send ${action} notification email for user ${userId} regarding ${leaveType}`);
    
    try {
        // Get user email from database
        console.log(`Fetching user details for ID: ${userId}`);
        const [userResult] = await dbPool.execute(
            'SELECT first_name, last_name, email FROM Users WHERE user_id = ?', 
            [userId]
        );
        
        if (userResult.length === 0) {
            console.error(`User not found for ID: ${userId}`);
            return;
        }
        
        const user = userResult[0];
        console.log(`Found user: ${user.first_name} ${user.last_name}, email: ${user.email}`);
        
        const subject = `Leave Request ${action === 'approve' ? 'Approved' : 'Rejected'}`;
        const text = `Dear ${user.first_name} ${user.last_name},

Your request for ${leaveType} has been ${action === 'approve' ? 'approved' : 'rejected'}.

Regards,
HR Team
Vipraco`;
        
        console.log(`Sending email to ${user.email} with subject: ${subject}`);
        console.log('Email configuration:', {
            service: process.env.EMAIL_SERVICE || 'gmail',
            user: process.env.EMAIL_USER,
            // Password hidden for security
        });
        
        // Send email
        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: user.email,
            subject,
            text
        });
        
        console.log(`Leave notification email sent to ${user.email}, messageId: ${info.messageId}`);
    } catch (error) {
        console.error('Error sending leave notification email:', error);
        console.error('Error details:', error.message);
        if (error.code === 'EAUTH') {
            console.error('Authentication error - check your email credentials');
        } else if (error.code === 'ESOCKET') {
            console.error('Socket error - check your network connection and email service configuration');
        }
        // Don't throw error - we don't want email failures to break the API response
    }
}

// Function to enforce organization-level access control
function enforceOrganizationAccess(sql, organizationId) {
    // Convert SQL to uppercase for case-insensitive checks
    const upperSql = sql.toUpperCase();
    
    // Check if this is a query that needs organization restriction
    const isSelect = upperSql.startsWith('SELECT');
    const isUpdate = upperSql.startsWith('UPDATE');
    const isInsert = upperSql.startsWith('INSERT');
    
    // If not a data access query, no need to modify
    if (!isSelect && !isUpdate && !isInsert) {
        return sql;
    }
    
    // Tables that contain organization_id and need to be restricted
    const restrictedTables = ['USERS', 'PAYROLLDATA', 'LEAVEBALANCES', 'COMPANYPOLICIES'];
    
    // Check if the query involves any of these tables
    const involvesRestrictedTable = restrictedTables.some(table => upperSql.includes(table));
    
    if (!involvesRestrictedTable) {
        return sql;
    }

    // Check if this is a query looking for a specific user by name
    const hasNameFilter = /WHERE.*first_name\s*=\s*['"](.*?)['"]|WHERE.*last_name\s*=\s*['"](.*?)['"]|WHERE.*LIKE\s*['"]%(.*?)%['"]/i.test(sql);
    
    // For queries with JOIN clauses
    if (upperSql.includes(' JOIN ')) {
        // Extract all table aliases in the query
        const tableAliasRegex = /(\w+)\s+(?:AS\s+)?([a-z])(?:\s+|\s*(?:ON|INNER|LEFT|RIGHT|JOIN|WHERE))/gi;
        const tableAliases = {};
        let match;
        
        while ((match = tableAliasRegex.exec(sql)) !== null) {
            tableAliases[match[2].toLowerCase()] = match[1].toLowerCase();
        }
        
        // Find all organization_id references in the WHERE clause
        let modifiedSql = sql;
        
        // Check if there's already an organization_id filter for Users table
        const hasUserOrgFilter = /u\.organization_id\s*=\s*['"].*?['"]/i.test(sql);
        
        // If there's a JOIN with Users table but no organization_id filter, add it
        if (tableAliases['u'] === 'users' && !hasUserOrgFilter) {
            // If there's a WHERE clause, add to it
            if (upperSql.includes(' WHERE ')) {
                modifiedSql = modifiedSql.replace(/WHERE\s+/i, `WHERE u.organization_id = '${organizationId}' AND `);
            } else {
                // If no WHERE clause, add one
                modifiedSql = `${modifiedSql} WHERE u.organization_id = '${organizationId}'`;
            }
            return modifiedSql;
        }
    }
    
    // For simple SELECT queries looking for users by name
    if (isSelect && hasNameFilter) {
        // Check if there's already an organization_id filter
        const hasOrgFilter = /organization_id\s*=\s*['"].*?['"]/i.test(sql);
        
        if (!hasOrgFilter) {
            // If there's a WHERE clause, add to it
            if (upperSql.includes(' WHERE ')) {
                return sql.replace(/WHERE\s+/i, `WHERE organization_id = '${organizationId}' AND `);
            } else {
                // If no WHERE clause, add one
                return `${sql} WHERE organization_id = '${organizationId}'`;
            }
        }
    }
    
    // For SELECT queries
    if (isSelect) {
        // If the query already has a WHERE clause, add organization restriction
        if (upperSql.includes(' WHERE ')) {
            // Check if there's already an organization_id filter
            const hasOrgFilter = /organization_id\s*=\s*['"].*?['"]/i.test(sql);
            
            if (!hasOrgFilter) {
                return sql.replace(/WHERE\s+/i, `WHERE organization_id = '${organizationId}' AND `);
            }
        } else {
            // If no WHERE clause, add one with organization restriction
            return `${sql} WHERE organization_id = '${organizationId}'`;
        }
    }
    
    // For UPDATE queries
    if (isUpdate) {
        // If the query already has a WHERE clause, add organization restriction
        if (upperSql.includes(' WHERE ')) {
            // Check if there's already an organization_id filter
            const hasOrgFilter = /organization_id\s*=\s*['"].*?['"]/i.test(sql);
            
            if (!hasOrgFilter) {
                return sql.replace(/WHERE\s+/i, `WHERE organization_id = '${organizationId}' AND `);
            }
        } else {
            // If no WHERE clause, add one with organization restriction
            return `${sql} WHERE organization_id = '${organizationId}'`;
        }
    }
    
    // For INSERT queries where we need to ensure the organization_id is correctly set
    if (isInsert && upperSql.includes('INSERT INTO')) {
        // If it's an INSERT with a SELECT, make sure the SELECT has organization filter
        if (upperSql.includes('SELECT')) {
            // Find the position of the SELECT
            const selectPos = upperSql.indexOf('SELECT');
            
            // Split the query at the SELECT
            const insertPart = sql.substring(0, selectPos);
            let selectPart = sql.substring(selectPos);
            
            // Add organization filter to the SELECT part if it's not already there
            if (!selectPart.includes(`organization_id = '${organizationId}'`)) {
                if (selectPart.toUpperCase().includes(' WHERE ')) {
                    selectPart = selectPart.replace(/WHERE\s+/i, `WHERE organization_id = '${organizationId}' AND `);
                } else {
                    selectPart = `${selectPart} WHERE organization_id = '${organizationId}'`;
                }
            }
            
            return insertPart + selectPart;
        }
        
        // Direct INSERT with VALUES - ensure organization_id is set correctly
        // This is more complex and would require parsing the column names and values
        // For now, we'll rely on the AI model to generate correct INSERTs
    }
    
    return sql;
}

// Add a helper function to check for simple greetings
function isSimpleGreeting(prompt) {
    const greetings = ['hi', 'hello', 'hey', 'greetings', 'howdy', 'hola', 'namaste'];
    const normalizedPrompt = prompt.toLowerCase().trim();
    
    // Check if the prompt is just a greeting or greeting with punctuation
    return greetings.includes(normalizedPrompt) || 
           greetings.some(greeting => normalizedPrompt === greeting + '!' || 
                                      normalizedPrompt === greeting + '.' ||
                                      normalizedPrompt === greeting + '?');
}

// --- API Endpoints ---

app.post('/ai-query', async (req, res) => {
    const { prompt } = req.body;
    const userId = req.headers['x-user-id'];
    const organizationId = req.headers['x-organization-id'];

    if (!prompt || !userId || !organizationId) {
        return res.status(400).json({ message: 'Missing prompt, user ID, or organization ID. Please provide all required information.' });
    }

    // Handle simple greetings directly without calling the AI
    if (isSimpleGreeting(prompt)) {
        return res.json({
            success: true,
            message: "Hello! I'm your HR assistant. How can I help you with HR-related questions today?",
            data: []
        });
    }

    try {
        const systemPrompt = await getSystemPrompt();
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const fullPrompt = `User's question: "${prompt}"\nMy user_id is: "${userId}"\nMy organization_id is: "${organizationId}"`;

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
            return res.status(500).json({ message: "I'm having trouble understanding your request. Could you please rephrase it?" });
        }

        let { sql: generatedSql, confirmation_message: confirmationMessage } = parsedResponse;
        
        console.log("Cleaned SQL:", generatedSql);

        if (generatedSql.toUpperCase() === 'MULTI_ACTION_ERROR') {
            return res.status(400).json({ message: confirmationMessage || "Your request involves multiple actions. Please send separate prompts for each action." });
        }

        if (generatedSql.toUpperCase() === 'IRRELEVANT') {
            return res.status(400).json({ message: confirmationMessage || "I am an HR assistant for Vipraco and can only answer questions about employee data, leave, payroll, and company policies. How can I help you with an HR-related query?" });
        }
        
        if (generatedSql.toUpperCase() === 'CROSS_ORG_ACCESS') {
            return res.status(403).json({ 
                success: false,
                message: confirmationMessage || "You don't have permission to access information about employees from other organizations." 
            });
        }

        if (!isQuerySafe(generatedSql)) {
            return res.status(403).json({ message: 'For security reasons, I cannot perform this operation. Please contact your system administrator if you need assistance.' });
        }
        
        // Remove trailing semicolon if exists
        if (generatedSql.endsWith(';')) {
            generatedSql = generatedSql.slice(0, -1);
        }
        
        // Fix any SQL syntax issues
        const fixedSql = fixSqlSyntax(generatedSql);
        
        // Enforce organization-level access control
        const restrictedSql = enforceOrganizationAccess(fixedSql, organizationId);

        try {
            // Validate if query is trying to access data from another organization
            const validationResult = await validateCrossOrgAccess(restrictedSql, organizationId);
            
            if (!validationResult.valid) {
                return res.status(403).json({
                    success: false,
                    message: validationResult.message
                });
            }
            
            const [queryResult] = await dbPool.execute(restrictedSql);
            
            // Log the SQL query execution details
            logSqlQuery(restrictedSql, prompt, queryResult);

            // For SELECT, result is an array of rows. For others, it's an info object.
            if (Array.isArray(queryResult)) {
                // Check if the data array is empty and provide a meaningful message
                if (queryResult.length === 0) {
                    // Extract the subject of the query from the confirmation message
                    // For example, from "Retrieved Ananya's base salary", extract "Ananya's base salary"
                    const subject = confirmationMessage.replace(/^(Found|Retrieved|Got|Fetched)\s+/, '');
                    const noDataMessage = `I couldn't find any information for the request: "${subject}". The data may not exist, or you might need to check the spelling. You could try asking to see all employees or all pending leaves to get more context.`;
                    
                    res.json({ success: true, message: noDataMessage, data: [] });
                    return;
                }
                
                res.json({ success: true, message: confirmationMessage, data: queryResult });
                return;
            }

            // For UPDATE queries, check if any rows were affected
            if (queryResult.affectedRows === 0) {
                const noUpdateMessage = `I couldn't perform the requested update. It seems no matching records were found. For example, if you're trying to approve a leave, you could first ask to "show all pending leave requests" to see available options.`;
                res.json({ success: false, message: noUpdateMessage, details: queryResult });
                return;
            }

            // Check if this is a leave approval or rejection and send email notification
            const isLeaveApproval = restrictedSql.includes('UPDATE LeaveBalances') && 
                                   (restrictedSql.includes('leaves_pending_approval = 0'));
            
            if (isLeaveApproval) {
                try {
                    // Extract user information from the SQL query
                    const userNameMatch = restrictedSql.match(/first_name\s*=\s*['"]([^'"]+)['"]/i);
                    const leaveTypeMatch = restrictedSql.match(/leave_type\s*=\s*['"]([^'"]+)['"]/i);
                    
                    if (userNameMatch) {
                        const firstName = userNameMatch[1];
                        
                        // Get user_id for the employee
                        const [userResults] = await dbPool.execute(
                            'SELECT user_id FROM Users WHERE first_name = ? AND organization_id = ?',
                            [firstName, organizationId]
                        );
                        
                        if (userResults.length > 0) {
                            const userId = userResults[0].user_id;
                            const leaveType = leaveTypeMatch ? leaveTypeMatch[1] : 'leave';
                            const action = restrictedSql.includes('leaves_taken = lb.leaves_taken + lb.leaves_pending_approval') ? 
                                'approve' : 'reject';
                            
                            // Send email notification and wait for it to complete to ensure it's sent in Lambda
                            await sendLeaveNotificationEmail(userId, action, leaveType);
                        }
                    }
                } catch (error) {
                    console.error('Error processing leave notification:', error);
                    // Don't let email notification errors affect the API response
                }
            }

            res.json({ success: true, message: confirmationMessage, details: queryResult });
        } catch (dbError) {
            // Use the enhanced error handler
            const errorResponse = handleDatabaseError(dbError, restrictedSql);
            // Convert error to message for user-friendly display
            return res.status(500).json({ 
                success: false,
                message: errorResponse.message || errorResponse.error,
                technical_details: {
                    details: errorResponse.details,
                    sql: errorResponse.sql
                }
            });
        }

    } catch (error) {
        console.error('Error processing AI query:', error);
        const userFriendlyMessage = "I encountered an issue while processing your request. Please try again or rephrase your question.";
        res.status(500).json({ success: false, message: userFriendlyMessage, technical_details: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('AI Backend is running!');
});

// Test endpoint for email verification
app.get('/test-email', async (req, res) => {
    try {
        // Create test email
        const testMailOptions = {
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER, // Send to yourself for testing
            subject: 'VIPRA HR Assistant - Email Test',
            text: 'This is a test email from VIPRA HR Assistant to verify email configuration.'
        };

        console.log('Attempting to send test email with config:', {
            service: process.env.EMAIL_SERVICE || 'gmail',
            user: process.env.EMAIL_USER,
            // Password hidden for security
        });

        // Send test email
        const info = await transporter.sendMail(testMailOptions);
        console.log('Test email sent successfully:', info.messageId);
        
        res.json({
            success: true,
            message: 'Test email sent successfully!',
            details: {
                messageId: info.messageId,
                to: process.env.EMAIL_USER,
                service: process.env.EMAIL_SERVICE || 'gmail'
            }
        });
    } catch (error) {
        console.error('Error sending test email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send test email',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

// For AWS Lambda
exports.handler = async (event, context) => {
    // Log the incoming event for debugging
    console.log('Event:', JSON.stringify(event));

    let response;

    try {
        // Parse the incoming request from API Gateway
        const path = event.path;
        const httpMethod = event.httpMethod;
        const headers = event.headers || {};
        let body = {};
        
        try {
            if (event.body) {
                body = JSON.parse(event.body);
            }
        } catch (error) {
            console.error('Error parsing request body:', error);
            // Even with a parse error, we should return a proper response
            response = {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid request body' })
            };
            return response; // Early exit
        }
        
        // Route the request based on path and method
        if (path === '/' && httpMethod === 'GET') {
            // Health check endpoint
            response = {
                statusCode: 200,
                body: 'AI Backend is running!'
            };
        } else if (path === '/ai-query' && httpMethod === 'POST') {
            // AI query endpoint
            const { prompt } = body;
            const userId = headers['x-user-id'];
            const organizationId = headers['x-organization-id'];
            
            if (!prompt || !userId || !organizationId) {
                response = {
                    statusCode: 400,
                    body: JSON.stringify({ message: 'Missing prompt, user ID, or organization ID. Please provide all required information.' }),
                };
            } else if (isSimpleGreeting(prompt)) {
                // Handle simple greetings directly without calling the AI
                response = {
                    statusCode: 200,
                    body: JSON.stringify({
                        success: true,
                        message: "Hello! I'm your HR assistant. How can I help you with HR-related questions today?",
                        data: []
                    })
                };
            } else {
                const systemPrompt = await getSystemPrompt();
                const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
                
                const fullPrompt = `User's question: "${prompt}"\nMy user_id is: "${userId}"\nMy organization_id is: "${organizationId}"`;
                
                const result = await model.generateContent([systemPrompt, fullPrompt]);
                const aiResponse = await result.response;
                let responseText = aiResponse.text().trim();
                
                // Robustly extract JSON from markdown block if present
                const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
                if (jsonMatch) {
                    responseText = jsonMatch[1].trim();
                }
                
                // Parse the AI's JSON response
                let parsedResponse;
                try {
                    parsedResponse = JSON.parse(responseText);
                } catch (e) {
                    console.error("Failed to parse JSON response from AI:", responseText);
                    response = {
                        statusCode: 500,
                        body: JSON.stringify({ message: "I'm having trouble understanding your request. Could you please rephrase it?" }),
                    };
                }

                if (response) { // If parsing failed, we already set the response
                    // do nothing
                } else {
                    let { sql: generatedSql, confirmation_message: confirmationMessage } = parsedResponse;
                
                    console.log("Cleaned SQL:", generatedSql);
                    
                    if (generatedSql.toUpperCase() === 'MULTI_ACTION_ERROR') {
                        response = {
                            statusCode: 400,
                            body: JSON.stringify({ message: confirmationMessage || "Your request involves multiple actions. Please send separate prompts for each action." }),
                        };
                    } else if (generatedSql.toUpperCase() === 'IRRELEVANT') {
                        response = {
                            statusCode: 400,
                            body: JSON.stringify({ message: confirmationMessage || "I am an HR assistant for Vipraco and can only answer questions about employee data, leave, payroll, and company policies. How can I help you with an HR-related query?" }),
                        };
                    } else if (generatedSql.toUpperCase() === 'CROSS_ORG_ACCESS') {
                        response = {
                            statusCode: 403,
                            body: JSON.stringify({ 
                                success: false,
                                message: confirmationMessage || "You don't have permission to access information about employees from other organizations." 
                            }),
                        };
                    } else if (!isQuerySafe(generatedSql)) {
                        response = {
                            statusCode: 403,
                            body: JSON.stringify({ message: 'For security reasons, I cannot perform this operation. Please contact your system administrator if you need assistance.' }),
                        };
                    } else {
                        // Remove trailing semicolon if exists
                        if (generatedSql.endsWith(';')) {
                            generatedSql = generatedSql.slice(0, -1);
                        }
                        
                        // Fix any SQL syntax issues
                        const fixedSql = fixSqlSyntax(generatedSql);
                        
                        // Enforce organization-level access control
                        const restrictedSql = enforceOrganizationAccess(fixedSql, organizationId);

                        try {
                            // Validate if query is trying to access data from another organization
                            const validationResult = await validateCrossOrgAccess(restrictedSql, organizationId);
                            
                            if (!validationResult.valid) {
                                response = {
                                    statusCode: 403,
                                    body: JSON.stringify({
                                        success: false,
                                        message: validationResult.message
                                    }),
                                };
                            } else {
                                const [queryResult] = await dbPool.execute(restrictedSql);
                                
                                // Log the SQL query execution details
                                logSqlQuery(restrictedSql, prompt, queryResult);
                                
                                let responseMessage = confirmationMessage;
                                let success = true;
                                
                                // Check if the data array is empty and provide a meaningful message
                                if (Array.isArray(queryResult) && queryResult.length === 0) {
                                    // Extract the subject of the query from the confirmation message
                                    const subject = confirmationMessage.replace(/^(Found|Retrieved|Got|Fetched)\s+/, '');
                                    responseMessage = `I couldn't find any information for the request: "${subject}". The data may not exist, or you might need to check the spelling. You could try asking to see all employees or all pending leaves to get more context.`;
                                }
                                
                                // For UPDATE queries, check if any rows were affected
                                if (!Array.isArray(queryResult) && queryResult.affectedRows === 0) {
                                    responseMessage = `I couldn't perform the requested update. It seems no matching records were found. For example, if you're trying to approve a leave, you could first ask to "show all pending leave requests" to see available options.`;
                                    success = false;
                                }
                                
                                // Check if this is a leave approval or rejection and send email notification
                                const isLeaveApproval = restrictedSql.includes('UPDATE LeaveBalances') && 
                                                       (restrictedSql.includes('leaves_pending_approval = 0'));
                                
                                if (isLeaveApproval) {
                                    try {
                                        // Extract user information from the SQL query
                                        const userNameMatch = restrictedSql.match(/first_name\s*=\s*['"]([^'"]+)['"]/i);
                                        const leaveTypeMatch = restrictedSql.match(/leave_type\s*=\s*['"]([^'"]+)['"]/i);
                                        
                                        if (userNameMatch) {
                                            const firstName = userNameMatch[1];
                                            
                                            // Get user_id for the employee
                                            const [userResults] = await dbPool.execute(
                                                'SELECT user_id FROM Users WHERE first_name = ? AND organization_id = ?',
                                                [firstName, organizationId]
                                            );
                                            
                                            if (userResults.length > 0) {
                                                const userId = userResults[0].user_id;
                                                const leaveType = leaveTypeMatch ? leaveTypeMatch[1] : 'leave';
                                                const action = restrictedSql.includes('leaves_taken = lb.leaves_taken + lb.leaves_pending_approval') ? 
                                                    'approve' : 'reject';
                                                
                                                // Send email notification and wait for it to complete to ensure it's sent in Lambda
                                                await sendLeaveNotificationEmail(userId, action, leaveType);
                                            }
                                        }
                                    } catch (error) {
                                        console.error('Error processing leave notification:', error);
                                        // Don't let email notification errors affect the API response
                                    }
                                }
                                
                                const responseBody = {
                                    success: success,
                                    message: responseMessage,
                                    data: Array.isArray(queryResult) ? queryResult : undefined,
                                    details: !Array.isArray(queryResult) ? queryResult : undefined,
                                };

                                response = {
                                    statusCode: 200,
                                    body: JSON.stringify(responseBody),
                                };
                            }
                        } catch (dbError) {
                            // Use the enhanced error handler
                            const errorResponse = handleDatabaseError(dbError, restrictedSql);
                            response = {
                                statusCode: 500,
                                body: JSON.stringify({ 
                                    success: false,
                                    message: errorResponse.message || errorResponse.error,
                                    technical_details: {
                                        details: errorResponse.details,
                                        sql: errorResponse.sql
                                    }
                                }),
                            };
                        }
                    }
                }
            }
        } else if (path === '/test-email' && httpMethod === 'GET') {
            // Test endpoint for email verification in Lambda
            try {
                // Create test email
                const testMailOptions = {
                    from: process.env.EMAIL_USER,
                    to: process.env.EMAIL_USER, // Send to yourself for testing
                    subject: 'VIPRA HR Assistant - Lambda Email Test',
                    text: 'This is a test email from VIPRA HR Assistant Lambda to verify email configuration.'
                };

                console.log('Lambda: Attempting to send test email with config:', {
                    service: process.env.EMAIL_SERVICE || 'gmail',
                    user: process.env.EMAIL_USER,
                    // Password hidden for security
                });

                // Send test email
                const info = await transporter.sendMail(testMailOptions);
                console.log('Lambda: Test email sent successfully:', info.messageId);
                
                response = {
                    statusCode: 200,
                    body: JSON.stringify({
                        success: true,
                        message: 'Test email sent successfully from Lambda!',
                        details: {
                            messageId: info.messageId,
                            to: process.env.EMAIL_USER,
                            service: process.env.EMAIL_SERVICE || 'gmail'
                        }
                    })
                };
            } catch (error) {
                console.error('Lambda: Error sending test email:', error);
                response = {
                    statusCode: 500,
                    body: JSON.stringify({
                        success: false,
                        message: 'Failed to send test email from Lambda',
                        error: error.message
                    })
                };
            }
        } else {
            // Route not found
            response = {
                statusCode: 404,
                body: JSON.stringify({ error: 'Not found' }),
            };
        }
    } catch (error) {
        console.error('Error processing request:', error);
        response = {
            statusCode: 500,
            body: JSON.stringify({ 
                success: false,
                message: 'I encountered an issue while processing your request. Please try again or rephrase your question.', 
                technical_details: error.message 
            }),
        };
    } finally {
        // Ensure headers are always added
        if (!response) {
            // Fallback for unexpected exit
            response = { 
                statusCode: 500, 
                body: JSON.stringify({ 
                    success: false,
                    message: 'I encountered an unexpected issue. Please try again later.' 
                }) 
            };
        }
        response.headers = {
            ...response.headers,
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        };
    }
    
    // Return the final response
    return response;
}; 