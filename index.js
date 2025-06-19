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
2. "confirmation_message": A user-friendly, natural-language string confirming what action was taken. For example: "Rahul Verma's base salary has been updated to 50000." or "Found the leave balance for Geeta Devi.".

**Constraints & Rules:**
1.  **Security First**: The "sql" value MUST NOT contain any query that modifies the database schema (e.g., DROP, ALTER, TRUNCATE) or deletes data (e.g., DELETE). You are only allowed to generate SELECT, INSERT, or UPDATE queries.
2.  **Single Action**: You can only perform one action (one SQL query) per prompt. 
3.  **Multi-Action Detection**: If the user asks to do multiple distinct actions (e.g., "update salary AND update leaves"), you MUST NOT generate SQL. Instead, set the "sql" value to "MULTI_ACTION_ERROR" and the "confirmation_message" to "Your request involves multiple actions. Please separate them into individual prompts for clarity and reliability."
4.  **Context is Key**: Use the provided database schema and sample data to understand the table structure and find the correct IDs for users like 'Amit' or 'Geeta'. The user's 'organization_id', 'user_id', and 'role' will be provided in the prompt for context.
5.  **Relevance**: If a question is unrelated to the HR schema (e.g., "What is the capital of France?"), you must not generate SQL. Set the "sql" value to "IRRELEVANT". For the "confirmation_message", provide a helpful response that politely declines the off-topic question and guides the user back to the HR assistant's capabilities. For example: "I am an HR assistant for Vipraco and can only answer questions about employee data, leave, payroll, and company policies. How can I help you with an HR-related query?"
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

    // Check for debug endpoint
    if (path === '/debug' || path === '/api/debug' || path === '/Prod/debug' || path === '/debug/') {
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({ message: "Success from simple handler on /debug" }),
        };
    }

    // Handle AI query endpoint
    if (path === '/ai-query' || path === '/api/ai-query' || path === '/Prod/ai-query' || path === '/ai-query/') {
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
                    body: JSON.stringify({ error: 'Missing prompt, x-user-id, or x-organization-id in request' })
                };
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
                    body: JSON.stringify({ error: 'User not found or not part of this organization.' })
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
                    body: JSON.stringify({ error: "Received an invalid response from the AI model." })
                };
            }

            let { sql: generatedSql, confirmation_message: confirmationMessage } = parsedResponse;
            
            console.log("Cleaned SQL:", generatedSql);

            if (generatedSql.toUpperCase() === 'MULTI_ACTION_ERROR') {
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ error: confirmationMessage || "The request involves multiple actions. Please send separate prompts." })
                };
            }

            if (generatedSql.toUpperCase() === 'IRRELEVANT') {
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ error: confirmationMessage || "This question is not relevant to HR data." })
                };
            }

            if (generatedSql.toUpperCase() === 'ACCESS_DENIED') {
                return {
                    statusCode: 403,
                    headers: headers,
                    body: JSON.stringify({ error: confirmationMessage || "Access denied." })
                };
            }

            if (generatedSql.toUpperCase() === 'AMBIGUOUS_QUERY') {
                return {
                    statusCode: 400,
                    headers: headers,
                    body: JSON.stringify({ error: confirmationMessage || "The query is ambiguous. Please provide more specific details." })
                };
            }

            if (!isQuerySafe(generatedSql)) {
                return {
                    statusCode: 403,
                    headers: headers,
                    body: JSON.stringify({ error: 'Generated query is not allowed for security reasons.' })
                };
            }
            
            // Remove trailing semicolon if exists
            if (generatedSql.endsWith(';')) {
                generatedSql = generatedSql.slice(0, -1);
            }

            const [queryResult] = await dbPool.execute(generatedSql);

            // For SELECT, result is an array of rows. For others, it's an info object.
            if (Array.isArray(queryResult)) {
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
                    error: 'Failed to process AI query.', 
                    details: error.message,
                    stack: error.stack 
                })
            };
        }
    }

    // Default response for any other path
    return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({ 
            message: "Not Found from simple handler",
            path: path,
            method: method
        }),
    };
}; 