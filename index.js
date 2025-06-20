require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mysql = require('mysql2/promise');

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

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Helper Functions ---

async function getSystemPrompt() {
    try {
        const schema = await fs.readFile('schema.txt', 'utf-8');
        const sample = await fs.readFile('sampledata.txt', 'utf-8');
        const exampleQueries = await fs.readFile('example queries.txt', 'utf-8');

        return `You are an expert SQL writer and an AI assistant for a company named "Vipraco".
Your role is to take a user's question in natural language and convert it into a single, executable SQL query.

**Output Format:**
Your entire output MUST be a single JSON object. This object must have two keys:
1. "sql": A string containing the single, executable SQL query.
2. "confirmation_message": A user-friendly, natural-language string confirming what action was taken. For example: "Rahul Verma's base salary has been updated to 50000." or "Found the leave balance for Geeta Devi.".

**Constraints & Rules:**
1.  **Security First**: The "sql" value MUST NOT contain any query that modifies the database schema (e.g., DROP, ALTER, TRUNCATE) or deletes data (e.g., DELETE). You are only allowed to generate SELECT, INSERT, or UPDATE queries.
2.  **Single Action**: You can only perform one action (one SQL query) per prompt. 
3.  **Multi-Action Detection**: If the user asks to do multiple distinct actions (e.g., "update salary AND update leaves"), you MUST NOT generate SQL. Instead, set the "sql" value to "MULTI_ACTION_ERROR" and the "confirmation_message" to "Your request involves multiple actions. Please separate them into individual prompts for clarity and reliability."
4.  **Context is Key**: Use the provided database schema and sample data to understand the table structure and find the correct IDs for users like 'Amit' or 'Geeta'. The user's 'organization_id' and 'user_id' will be provided in the prompt for context.
5.  **Relevance**: If a question is unrelated to the HR schema (e.g., "What is the capital of France?"), you must not generate SQL. Set the "sql" value to "IRRELEVANT". For the "confirmation_message", provide a helpful response that politely declines the off-topic question and guides the user back to the HR assistant's capabilities. For example: "I am an HR assistant for Vipraco and can only answer questions about employee data, leave, payroll, and company policies. How can I help you with an HR-related query?"
6.  **Precise User Identification**: When updating or querying data for a specific user mentioned by name (e.g., "Ananya", "Rahul"), always include the full WHERE clause with both first_name and organization_id. For example, use "WHERE first_name = 'Ananya' AND organization_id = 'TECHCORP_IN'" instead of just "WHERE first_name = 'Ananya'".
7.  **MySQL Syntax**: Use correct MySQL syntax for joins. For UPDATE queries with joins, use "UPDATE table1 INNER JOIN table2 ON table1.col = table2.col SET table1.col = value WHERE conditions". Do NOT use "UPDATE table1 SET col = value FROM table2" as this syntax is not supported in MySQL.
8.  **Required Fields**: When inserting data, always include ALL required fields. For PayrollData, you must include: organization_id, user_id, base_salary, and ctc. For example, when inserting salary data, always calculate and include the ctc (Cost to Company) value.
9.  **Prefer Update Over Insert**: For salary operations, prefer UPDATE over INSERT if the record likely exists. Only use INSERT when explicitly told to create a new record.

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
   
2. Query: "Set Ananya's salary to 30000"
   SQL: "UPDATE PayrollData pd INNER JOIN Users u ON pd.user_id = u.user_id SET pd.base_salary = 30000 WHERE u.first_name = 'Ananya' AND u.organization_id = 'TECHCORP_IN'"

3. Query: "What is Rahul's department?"
   SQL: "SELECT department FROM Users WHERE first_name = 'Rahul' AND organization_id = 'TECHCORP_IN'"

4. Query: "Create a new salary record for Ananya with base salary 30000"
   SQL: "INSERT INTO PayrollData (organization_id, user_id, base_salary, HRA, conveyance_allowance, medical_allowance, pf_deduction, esi_deduction, professional_tax, ctc) SELECT 'TECHCORP_IN', user_id, 30000, 15000, 3000, 1000, 3600, 0, 200, 55000 FROM Users WHERE first_name = 'Ananya' AND organization_id = 'TECHCORP_IN'"
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
            let tableName = '';
            if (sql.toUpperCase().includes('INSERT INTO')) {
                const tableMatch = sql.match(/INSERT INTO\s+(\w+)/i);
                if (tableMatch && tableMatch[1]) {
                    tableName = tableMatch[1];
                }
            }
            
            // Provide a user-friendly error message
            errorResponse.error = `Missing required information`;
            
            // Create a more natural language message based on the field and table
            if (tableName === 'PayrollData') {
                if (fieldName === 'ctc') {
                    errorResponse.message = "To add salary information, you need to provide the CTC (Cost to Company) value. Please include this in your request.";
                } else if (fieldName === 'base_salary') {
                    errorResponse.message = "To add salary information, you need to provide the base salary. Please include this in your request.";
                } else {
                    errorResponse.message = `To add salary information, you need to provide the ${fieldName.replace(/_/g, ' ')}. Please include this in your request.`;
                }
            } else {
                errorResponse.message = `The ${fieldName.replace(/_/g, ' ')} is required but was not provided. Please include this information in your request.`;
            }
        }
    } else if (error.code === 'ER_DUP_ENTRY') {
        // Duplicate entry error
        errorResponse.error = "This record already exists.";
        errorResponse.message = "This information is already in our system. If you want to update it, please use an update request instead.";
    } else if (error.code === 'ER_NO_REFERENCED_ROW') {
        // Foreign key constraint error
        errorResponse.error = "Referenced record not found.";
        errorResponse.message = "One of the references in your request doesn't exist in our system. Please check the information and try again.";
    }
    
    return errorResponse;
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

        if (!isQuerySafe(generatedSql)) {
            return res.status(403).json({ message: 'For security reasons, I cannot perform this operation. Please contact your system administrator if you need assistance.' });
        }
        
        // Remove trailing semicolon if exists
        if (generatedSql.endsWith(';')) {
            generatedSql = generatedSql.slice(0, -1);
        }
        
        // Fix any SQL syntax issues
        const fixedSql = fixSqlSyntax(generatedSql);

        try {
            const [queryResult] = await dbPool.execute(fixedSql);
            
            // Log the SQL query execution details
            logSqlQuery(fixedSql, prompt, queryResult);

            // For SELECT, result is an array of rows. For others, it's an info object.
            if (Array.isArray(queryResult)) {
                // Check if the data array is empty and provide a meaningful message
                if (queryResult.length === 0) {
                    // Extract the subject of the query from the confirmation message
                    // For example, from "Retrieved Ananya's base salary", extract "Ananya's base salary"
                    const subject = confirmationMessage.replace(/^(Found|Retrieved|Got|Fetched)\s+/, '');
                    const noDataMessage = `I couldn't find any information about ${subject}. The data may not exist in our records.`;
                    
                    res.json({ success: true, message: noDataMessage, data: [] });
                    return;
                }
                
                res.json({ success: true, message: confirmationMessage, data: queryResult });
                return;
            }

            // For UPDATE queries, check if any rows were affected
            if (queryResult.affectedRows === 0) {
                const noUpdateMessage = `I couldn't update ${confirmationMessage.toLowerCase().replace('has been updated', 'because no matching records were found')}`;
                res.json({ success: false, message: noUpdateMessage, details: queryResult });
                return;
            }

            res.json({ success: true, message: confirmationMessage, details: queryResult });
        } catch (dbError) {
            // Use the enhanced error handler
            const errorResponse = handleDatabaseError(dbError, fixedSql);
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

                        try {
                            const [queryResult] = await dbPool.execute(fixedSql);
                            
                            // Log the SQL query execution details
                            logSqlQuery(fixedSql, prompt, queryResult);
                            
                            let responseMessage = confirmationMessage;
                            let success = true;
                            
                            // Check if the data array is empty and provide a meaningful message
                            if (Array.isArray(queryResult) && queryResult.length === 0) {
                                // Extract the subject of the query from the confirmation message
                                const subject = confirmationMessage.replace(/^(Found|Retrieved|Got|Fetched)\s+/, '');
                                responseMessage = `I couldn't find any information about ${subject}. The data may not exist in our records.`;
                            }
                            
                            // For UPDATE queries, check if any rows were affected
                            if (!Array.isArray(queryResult) && queryResult.affectedRows === 0) {
                                responseMessage = `I couldn't update ${confirmationMessage.toLowerCase().replace('has been updated', 'because no matching records were found')}`;
                                success = false;
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
                        } catch (dbError) {
                            // Use the enhanced error handler
                            const errorResponse = handleDatabaseError(dbError, fixedSql);
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