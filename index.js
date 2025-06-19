require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const corsOptions = {
    origin: (origin, callback) => {
        if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
};
app.use(cors(corsOptions));

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
        const sample = await fs.readFile('sample.txt', 'utf-8');
        const exampleQueries = await fs.readFile('example queries.txt', 'utf-8');

        return `You are an expert SQL writer and an AI assistant for a company named "Vipraco".
Your role is to take a user's question in natural language and convert it into a single, executable SQL query.

**Constraints & Rules:**
1.  **Security First**: You MUST NOT generate any query that modifies the database schema (e.g., DROP, ALTER, TRUNCATE). You MUST NOT generate any query that deletes data from a table (e.g., DELETE). You are only allowed to generate SELECT, INSERT, or UPDATE queries.
2.  **Output Format**: Your entire output must be ONLY the SQL query. Do not include any other text, explanation, or markdown formatting like \`\`\`sql.
3.  **Single Query**: Always generate a single SQL query. Do not generate multiple queries.
4.  **Context is Key**: Use the provided database schema and sample data to understand the table structure, relationships, and data format. The user's 'organization_id' and 'user_id' will be provided in the prompt. You must use them to filter the data appropriately.
5.  **Relevance**: Only answer questions related to the provided HR schema. If a question is unrelated (e.g., "What is the capital of France?"), you must output the single word: "IRRELEVANT".

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


// --- API Endpoints ---

app.post('/api/ai-query', async (req, res) => {
    const { prompt } = req.body;
    const userId = req.headers['x-user-id'];
    const organizationId = req.headers['x-organization-id'];

    if (!prompt || !userId || !organizationId) {
        return res.status(400).json({ error: 'Missing prompt, x-user-id, or x-organization-id in request' });
    }

    try {
        const systemPrompt = await getSystemPrompt();
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const fullPrompt = `User's question: "${prompt}"\nMy user_id is: "${userId}"\nMy organization_id is: "${organizationId}"`;

        const result = await model.generateContent([systemPrompt, fullPrompt]);
        const response = await result.response;
        let generatedSql = response.text().trim();

        // Robustly extract SQL from markdown block if present
        const sqlMatch = generatedSql.match(/```(?:sql)?\s*([\s\S]+?)\s*```/);
        if (sqlMatch) {
            generatedSql = sqlMatch[1].trim();
        }

        console.log("Cleaned SQL:", generatedSql);

        if (generatedSql.toUpperCase() === 'IRRELEVANT') {
            return res.status(400).json({ error: "This question is not relevant to HR data." });
        }

        if (!isQuerySafe(generatedSql)) {
            return res.status(403).json({ error: 'Generated query is not allowed for security reasons.' });
        }
        
        // Remove trailing semicolon if exists
        if (generatedSql.endsWith(';')) {
            generatedSql = generatedSql.slice(0, -1);
        }

        const [queryResult] = await dbPool.execute(generatedSql);

        // For SELECT, queryResult is an array of rows. For others, it's an info object.
        if (Array.isArray(queryResult)) {
            res.json({ success: true, data: queryResult });
            return;
        }

        // Handle INSERT, UPDATE responses with more descriptive messages
        const queryType = generatedSql.trim().split(' ')[0].toUpperCase();
        let message = 'Query executed successfully.';

        if (queryType === 'UPDATE') {
            if (queryResult.changedRows > 0) {
                message = `Successfully updated ${queryResult.changedRows} record(s).`;
            } else if (queryResult.affectedRows > 0 && queryResult.changedRows === 0) {
                message = 'A matching record was found, but no changes were needed as the values were already the same.';
            } else {
                message = 'Query executed, but no records matched the criteria to be updated.';
            }
        } else if (queryType === 'INSERT') {
            if (queryResult.affectedRows > 0) {
                message = `Successfully inserted ${queryResult.affectedRows} new record(s).`;
            } else {
                message = 'Query executed, but no new records were inserted.';
            }
        }

        res.json({ success: true, message, details: queryResult });

    } catch (error) {
        console.error('Error processing AI query:', error);
        res.status(500).json({ error: 'Failed to process AI query.', details: error.message });
    }
});

app.get('/', (req, res) => {
    res.send('AI Backend is running!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
}); 