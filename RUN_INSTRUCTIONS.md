# Step 1: Install Dependencies
cd vipra-admin-stack
npm install

# Step 2: Create .env file
Create a file named `.env` in the `vipra-admin-stack` directory and add the following content. 
Make sure to replace the placeholder values with your actual database credentials and API key.

```
# Server Configuration
PORT=5000
ALLOWED_ORIGINS=http://localhost:3000

# Database Configuration
DB_HOST=localhost
DB_USER=your_mysql_user
DB_PASSWORD=your_mysql_password
DB_NAME=your_mysql_database
DB_PORT=3306

# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key
```

# Step 3: Set up the database
You need to have a MySQL database running. 
Connect to your MySQL server and execute the following SQL commands to create the tables and insert some sample data.

## Database Schema
```sql
-- Table 1: Organizations (Master table for tenants)
-- Stores details of each client organization.
CREATE TABLE Organizations (
    organization_id VARCHAR(50) PRIMARY KEY, -- Unique ID for each client organization
    org_name VARCHAR(255) NOT NULL,
    subscription_plan VARCHAR(50), -- e.g., 'Enterprise', 'Standard', 'Basic'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Table 2: Users (Employee Master Data)
-- Stores core employee information. user_id and manager_id reference this table.
-- password_hash should store securely hashed passwords (e.g., using bcrypt).
CREATE TABLE Users (
    user_id VARCHAR(50) PRIMARY KEY,
    organization_id VARCHAR(50) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL, -- Store hashed passwords, not plain text!
    role VARCHAR(100) NOT NULL, -- e.g., 'Employee', 'Manager', 'Admin'
    manager_id VARCHAR(50), -- Self-referencing FK to Users.user_id (can be NULL for top managers)
    date_of_joining DATE NOT NULL,
    department VARCHAR(100),
    location VARCHAR(100),
    FOREIGN KEY (organization_id) REFERENCES Organizations(organization_id),
    FOREIGN KEY (manager_id) REFERENCES Users(user_id)
);
-- Table 3: LeaveBalances
-- Stores current leave balances for each employee.
CREATE TABLE LeaveBalances (
    balance_id SERIAL PRIMARY KEY, -- Auto-incrementing unique ID for this record
    organization_id VARCHAR(50) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    leave_type VARCHAR(50) NOT NULL, -- e.g., 'Casual Leave', 'Sick Leave', 'Earned Leave'
    total_allotted INT NOT NULL,
    leaves_taken INT NOT NULL DEFAULT 0,
    leaves_pending_approval INT NOT NULL DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES Organizations(organization_id),
    FOREIGN KEY (user_id) REFERENCES Users(user_id)
);

-- Table 4: CompanyPolicies (Knowledge Base)
-- Stores key company policies and FAQs, accessible by the VipraCo.
CREATE TABLE CompanyPolicies (
    policy_id SERIAL PRIMARY KEY,
    organization_id VARCHAR(50) NOT NULL,
    policy_title VARCHAR(255) NOT NULL,
    policy_category VARCHAR(100), -- e.g., 'Leave', 'Expense', 'IT', 'HR General'
    policy_content TEXT NOT NULL, -- The actual text of the policy/FAQ
    last_reviewed DATE,
    keywords TEXT, -- Comma-separated keywords for faster search/embedding (for hackathon)
    FOREIGN KEY (organization_id) REFERENCES Organizations(organization_id)
);
-- Table 5: PayrollData (Simplified for this project)
-- Stores basic current payroll information for each employee.
-- In a real system, this would be linked to payroll processing cycles.
CREATE TABLE PayrollData (
    payroll_id SERIAL PRIMARY KEY,
    organization_id VARCHAR(50) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    base_salary DECIMAL(10, 2) NOT NULL,
    HRA DECIMAL(10, 2), -- House Rent Allowance
    conveyance_allowance DECIMAL(10, 2),
    medical_allowance DECIMAL(10, 2),
    pf_deduction DECIMAL(10, 2), -- Provident Fund
    esi_deduction DECIMAL(10, 2), -- Employee State Insurance
    professional_tax DECIMAL(10, 2), -- Specific to Indian states
    ctc DECIMAL(10, 2) NOT NULL, -- Cost to Company
    FOREIGN KEY (organization_id) REFERENCES Organizations(organization_id),
    FOREIGN KEY (user_id) REFERENCES Users(user_id)
);
```

## Sample Data
```sql
-- Sample Data for Organizations
INSERT INTO Organizations (organization_id, org_name, subscription_plan) 
VALUES
('TECHCORP_IN', 'TechCorp Innovations Pvt. Ltd.', 'Basic'),
('MGFAB_GLOBAL', 'Muzaffarpur Global Fabricators', 'Standard'),
('EDU_INST', 'BMS Education Institute', 'Enterprise');

-- Sample Data for Users
-- TechCorp Innovations (organization_id: TECHCORP_IN)
INSERT INTO Users (user_id, organization_id, first_name, last_name, email, password_hash, role, manager_id, date_of_joining, department, location) 
VALUES
('TCI_MGR001', 'TECHCORP_IN', 'Ananya', 'Sharma', 'ananya.sharma@techcorp.com', 'hashed_pass_ananya', 'Manager', NULL, '2020-01-15', 'Engineering', 'Bangalore'),
('TCI_EMP002', 'TECHCORP_IN', 'Rahul', 'Verma', 'rahul.verma@techcorp.com', 'hashed_pass_rahul', 'Employee', 'TCI_MGR001', '2021-03-10', 'Engineering', 'Bangalore'),
('TCI_HR003', 'TECHCORP_IN', 'Priya', 'Singh', 'priya.singh@techcorp.com', 'hashed_pass_priya', 'Admin', NULL, '2019-07-20', 'Human Resources', 'Bangalore'),
('TCI_EMP004', 'TECHCORP_IN', 'Amit', 'Kumar', 'amit.kumar@techcorp.com', 'hashed_pass_amit', 'Employee', 'TCI_MGR001', '2022-06-01', 'Engineering', 'Bangalore');

-- Muzaffarpur Global Fabricators (organization_id: MGFAB_GLOBAL)
INSERT INTO Users (user_id, organization_id, first_name, last_name, email, password_hash, role, manager_id, date_of_joining, department, location) 
VALUES
('MGF_MGR001', 'MGFAB_GLOBAL', 'Suresh', 'Kumar', 'suresh.kumar@mgfab.com', 'hashed_pass_suresh', 'Manager', NULL, '2018-05-01', 'Production', 'Muzaffarpur, UP'),
('MGF_EMP002', 'MGFAB_GLOBAL', 'Geeta', 'Devi', 'geeta.devi@mgfab.com', 'hashed_pass_geeta', 'Employee', 'MGF_MGR001', '2022-09-01', 'Quality Control', 'Muzaffarpur, UP');

-- Sample Data for LeaveBalances
-- TechCorp Innovations
INSERT INTO LeaveBalances (organization_id, user_id, leave_type, total_allotted, leaves_taken, leaves_pending_approval) 
VALUES
('TECHCORP_IN', 'TCI_EMP002', 'Casual Leave', 12, 5, 0),
('TECHCORP_IN', 'TCI_EMP002', 'Sick Leave', 8, 2, 0),
('TECHCORP_IN', 'TCI_EMP002', 'Earned Leave', 18, 6, 2), -- 2 leaves pending approval
('TECHCORP_IN', 'TCI_MGR001', 'Casual Leave', 12, 3, 0),
('TECHCORP_IN', 'TCI_EMP004', 'Casual Leave', 12, 1, 0);

-- Muzaffarpur Global Fabricators
INSERT INTO LeaveBalances (organization_id, user_id, leave_type, total_allotted, leaves_taken, leaves_pending_approval) 
VALUES
('MGFAB_GLOBAL', 'MGF_EMP002', 'Casual Leave', 10, 4, 0),
('MGFAB_GLOBAL', 'MGF_EMP002', 'Sick Leave', 7, 1, 0);

-- Sample Data for CompanyPolicies
-- TechCorp Innovations
INSERT INTO CompanyPolicies (organization_id, policy_title, policy_category, policy_content, last_reviewed, keywords) 
VALUES
('TECHCORP_IN', 'Work from Home Policy', 'HR General', 'Employees are allowed to work from home for up to 2 days a week, with prior manager approval. Ensure stable internet connection and productive environment. This applies to all non-production roles.', '2024-10-01', 'WFH, remote, flexible, home, policy'),
('TECHCORP_IN', 'Travel & Expense Policy', 'Expense', 'All business travel expenses must be pre-approved by your manager. Reimbursements require submission of original receipts within 7 days. Daily allowance for domestic travel is INR 1500.', '2023-11-15', 'travel, expense, reimbursement, allowance, policy'),
('TECHCORP_IN', 'Next Company Holiday', 'Calendar', 'The next company holiday for all TechCorp employees in Bangalore is Independence Day, August 15, 2025.', '2025-01-01', 'holiday, vacation, August 15, Independence Day');

-- Muzaffarpur Global Fabricators
INSERT INTO CompanyPolicies (organization_id, policy_title, policy_category, policy_content, last_reviewed, keywords) 
VALUES
('MGFAB_GLOBAL', 'Attendance & Punctuality Policy', 'HR General', 'All factory employees must clock in daily using biometric scanners. Lateness will result in a deduction from pay after 3 instances. Strict adherence to shift timings is required.', '2024-03-01', 'attendance, punctuality, clock-in, biometric, policy'),
('MGFAB_GLOBAL', 'Safety Regulations Policy', 'Safety', 'All personnel must wear mandatory safety gear (helmets, gloves, safety shoes) in production areas. Report any hazards immediately. Regular safety drills are conducted.', '2024-01-20', 'safety, regulations, PPE, hazards, drills, policy'),
('MGFAB_GLOBAL', 'Bihar State Holidays 2025', 'Calendar', 'Upcoming public holidays in UP for 2025 include Diwali (Oct 29), Chhath Puja (Nov 5-6), and Christmas (Dec 25).', '2025-01-01', 'UP, holiday, public holiday, festival');

-- Sample Data for PayrollData
-- TechCorp Innovations
INSERT INTO PayrollData (organization_id, user_id, base_salary, HRA, conveyance_allowance, medical_allowance, pf_deduction, esi_deduction, professional_tax, ctc) 
VALUES
('TECHCORP_IN', 'TCI_MGR001', 80000.00, 40000.00, 8000.00, 3000.00, 9600.00, 0.00, 200.00, 150000.00),
('TECHCORP_IN', 'TCI_EMP002', 45000.00, 22500.00, 4500.00, 1500.00, 5400.00, 0.00, 150.00, 85000.00);

-- Muzaffarpur Global Fabricator
INSERT INTO PayrollData (organization_id, user_id, base_salary, HRA, conveyance_allowance, medical_allowance, pf_deduction, esi_deduction, professional_tax, ctc) 
VALUES
('MGFAB_GLOBAL', 'MGF_MGR001', 60000.00, 30000.00, 6000.00, 2000.00, 7200.00, 1800.00, 100.00, 110000.00),
('MGFAB_GLOBAL', 'MGF_EMP002', 30000.00, 15000.00, 3000.00, 1000.00, 3600.00, 900.00, 50.00, 55000.00);
```

# Step 4: Run the Application
Once the dependencies are installed, the `.env` file is created, and the database is set up, you can start the application with the following command:

```bash
node index.js
```

The server should start on port 5000 (or the port you specified in your `.env` file). 