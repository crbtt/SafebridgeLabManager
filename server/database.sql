CREATE DATABASE safebridgetest;

-- Create ClientID table
CREATE TABLE ClientID (
    client_id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    company VARCHAR(255) NOT NULL
);

-- Create EmployeeID table
CREATE TABLE EmployeeID (
    employee_id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(255) NOT NULL
);

-- Create Methods table
CREATE TABLE Methods (
    method_number INTEGER,
    revision_number INTEGER,
    compound VARCHAR(255) NOT NULL,
    air_loq FLOAT NOT NULL,
    surface_loq FLOAT NOT NULL,
    PRIMARY KEY (method_number, revision_number)
);

-- Create ClientIntake table
CREATE TABLE ClientIntake (
    sbreport SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES ClientID(client_id),
    num_samples INTEGER NOT NULL CHECK (num_samples > 0),
    site_sampling VARCHAR(255),
    sample_collector VARCHAR(255),
    reporting_unit_air VARCHAR(50),
    reporting_unit_surface VARCHAR(50),
    method INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    FOREIGN KEY (method, revision) REFERENCES Methods(method_number, revision_number),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create SampleInfo table
CREATE TABLE SampleInfo (
    sbreport INTEGER REFERENCES ClientIntake(sbreport),
    sbid INTEGER,
    client_assigned_name VARCHAR(255) NOT NULL,
    air_volume FLOAT,
    surface_area FLOAT,
    date_sampled DATE,
    mass FLOAT,
    PRIMARY KEY (sbreport, sbid),
    CONSTRAINT check_measurement_type 
        CHECK ((air_volume IS NULL AND surface_area IS NOT NULL) OR 
               (air_volume IS NOT NULL AND surface_area IS NULL)),
    CONSTRAINT check_sbid_positive
        CHECK (sbid > 0)
);

-- Create AnalysisReporterInfo table with nullable extraction_date & analysis_start_date
CREATE TABLE AnalysisReporterInfo (
    sbreport INTEGER PRIMARY KEY REFERENCES ClientIntake(sbreport),
    num_samples_analyzed INTEGER NOT NULL CHECK (num_samples_analyzed > 0),
    conditions_upon_arrival TEXT NOT NULL,
    storage_conditions TEXT NOT NULL,
    extraction_date DATE,  -- Changed from NOT NULL to NULLABLE
    analysis_start_date DATE, -- Changed from NOT NULL to NULLABLE
    analysis_end_date DATE,
    analysis_unit VARCHAR(50) NOT NULL,
    preparer_id INTEGER REFERENCES EmployeeID(employee_id),
    reviewer_id INTEGER REFERENCES EmployeeID(employee_id),
    date_received DATE,
    due_date DATE,
    project_number VARCHAR(255),
    date_reported DATE,
    CONSTRAINT check_analysis_dates
        CHECK (
            -- Ensure valid date progression but allow NULLs
            (extraction_date IS NULL OR analysis_start_date IS NULL OR extraction_date <= analysis_start_date)
            AND
            (analysis_end_date IS NULL OR analysis_end_date >= analysis_start_date)
        )
);


-- Create indexes for frequently accessed columns
CREATE INDEX idx_sampleinfo_sbreport ON SampleInfo(sbreport);
CREATE INDEX idx_clientintake_client_id ON ClientIntake(client_id);