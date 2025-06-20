# VIPRA HR Assistant API

This is a serverless HR Assistant API built using Node.js, Express, and AWS Lambda. It uses the Google Gemini AI model to interpret natural language queries and convert them into SQL queries for an HR database.

## Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) installed and configured
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) installed
- [Node.js](https://nodejs.org/) (v18.x or later)
- A Google Gemini API key

## Local Development

1. Install dependencies:
   ```
   npm install
   ```

2. Create a `.env` file with the following content:
   ```
   # Database Configuration
   DB_HOST=shortline.proxy.rlwy.net
   DB_PORT=49692
   DB_NAME=railway
   DB_USER=root
   DB_PASSWORD=fwbmUuEstVNVheIibURuBIOhlveCVZjo

   # Server Configuration
   PORT=5000
   NODE_ENV=development

   # JWT Configuration
   JWT_SECRET=aVeryLongAndRandomSecretKeyForYourApp

   # Gemini API Key - Replace with your actual key
   GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

   # Cors Configuration
   ALLOWED_ORIGINS=http://localhost:3000,
   
   # Email Configuration (for leave notifications)
   EMAIL_SERVICE=gmail
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASSWORD=your_app_password
   ```

3. Start the local server:
   ```
   node index.js
   ```

## Features

### Email Notifications for Leave Approvals/Rejections

The system automatically sends email notifications to employees when their leave requests are approved or rejected by an admin. This feature:

- Sends personalized emails with the employee's name and leave type
- Works asynchronously to prevent delays in API responses
- Gracefully handles email sending failures without affecting core functionality

To configure email notifications:

1. Add the required email configuration to your `.env` file:
   ```
   EMAIL_SERVICE=gmail
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASSWORD=your_app_password
   ```
   
   Note: For Gmail, you need to use an App Password, not your regular password.
   Generate one at: https://myaccount.google.com/apppasswords

2. Test the feature by approving or rejecting a leave request:
   ```
   # Example prompt to approve leave
   "Approve Rahul's earned leave"
   
   # Example prompt to reject leave
   "Reject Amit's leave request"
   ```

## Deployment to AWS Lambda

### Step 1: Package the Application

```bash
sam build
```

This command will create a `.aws-sam` directory with the packaged code.

### Step 2: Deploy the Application

```bash
sam deploy --guided
```

During the guided deployment, you will be prompted for several parameters:

- **Stack Name**: Name of the CloudFormation stack (default: vipra-hr-assistant)
- **AWS Region**: AWS region to deploy to (default: us-east-1)
- **Parameter Environment**: Environment (dev, staging, prod)
- **Parameter GeminiAPIKey**: Your Google Gemini API key
- **Confirm changes before deploy**: Confirm changes before deploying (recommended: yes)
- **Allow SAM CLI IAM role creation**: Allow SAM to create IAM roles (recommended: yes)
- **Disable rollback**: Disable rollback if errors occur (recommended: no)
- **Save arguments to samconfig.toml**: Save these settings for future deployments (recommended: yes)

### Step 3: Test the Deployed API

After deployment, SAM will output the API Gateway endpoint URL. You can test it using Postman or curl:

```bash
curl -X POST \
  https://YOUR_API_GATEWAY_URL/Prod/ai-query \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: TCI_HR003' \
  -H 'x-organization-id: TECHCORP_IN' \
  -d '{"prompt": "What is my employee ID?"}'
```

## API Endpoints

- **GET /** - Health check endpoint
- **POST /ai-query** - Main endpoint for AI-powered HR queries

## Important Notes

1. **Path Handling**: The API Gateway strips the base path before forwarding requests to Lambda. For example, if your API Gateway URL is `https://example.com/Prod`, a request to `https://example.com/Prod/ai-query` will be received by your Lambda as `/ai-query`.

2. **CORS**: The API has CORS enabled for all origins (`*`). For production, you should restrict this to your frontend domain.

3. **Security**: The database credentials and API keys are stored as environment variables in AWS Lambda. Make sure to keep your `samconfig.toml` and `.env` files secure and never commit them to public repositories.

4. **Updating the Deployment**: To update your deployed function after making changes, run:
   ```
   sam build && sam deploy
   ```

5. **Monitoring**: You can monitor your Lambda function's logs via CloudWatch Logs.

## Cleanup

To remove all resources created by this deployment:

```bash
aws cloudformation delete-stack --stack-name vipra-hr-assistant
``` 