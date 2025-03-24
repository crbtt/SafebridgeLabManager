const express = require("express");
const app = express();
const cors = require("cors");
const pool = require("./db");
const bodyParser = require('body-parser');

// middleware
app.use(cors());
app.use(express.json()); // req.body
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Helper function to format date as YYYY-MM-DD
const formatDate = (dateString) => {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return null; 
    return date.toISOString().split('T')[0];
  } catch (e) {
    return null;
  }
};

// ROUTES
// Routes built: Submit new report, view all reports, view specific report, update existing report, pull method data, delete a report

// METHOD GET
app.get("/methods", async (req, res) =>{
  try {
      const allMethods = await pool.query("SELECT * FROM methods");
      res.json(allMethods.rows);
  } catch (error) {
      console.error(err.message);
  res.status(500).json({ success: false, message: "Server error" });
  }
})

// CLIENTID GETS
app.get("/clients", async (req, res) => {
  try {
      const { company } = req.query;
      if (!company) {
          return res.status(400).json({ success: false, message: "Company name is required" });
      }

      const clientData = await pool.query(
          "SELECT * FROM clientid WHERE company ILIKE $1", 
          [`%${company}%`]
      );

      res.json(clientData.rows);
  } catch (error) {
      console.error("Error fetching client data:", error);
      res.status(500).json({ success: false, message: "Server error" });
  }
});

// CLIENT SAMPLE SUBMISSION
app.post("/clientSampleIntake", async (req, res) => {
  try {
    const { clientInfo, samples } = req.body;

    // Validate required data
    if (!clientInfo || !samples || !Array.isArray(samples) || samples.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing or invalid data. Client info and at least one sample are required." 
      });
    }

    // Validate client info fields
    const requiredClientFields = ['email', 'name', 'company', 'numSamples', 'methodID', 'revision'];
    const missingClientFields = requiredClientFields.filter(field => !clientInfo[field]);
    
    if (missingClientFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required client info fields: ${missingClientFields.join(', ')}`
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(clientInfo.email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format"
      });
    }

    // Validate samples structure
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (!sample.ClientName || !sample.DateSampled) {
        return res.status(400).json({
          success: false,
          message: `Sample at index ${i} is missing required fields: ClientName and DateSampled are required`
        });
      }

      // Validate measurement type - either AirVolume or SurfaceArea must be provided, but not both
      if ((!sample.AirVolume && !sample.SurfaceArea) || 
          (sample.AirVolume && sample.SurfaceArea)) {
        return res.status(400).json({
          success: false,
          message: `Sample "${sample.ClientName}" must have either AirVolume or SurfaceArea, but not both`
        });
      }
    }

    // Start a transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Insert client info (ensure email uniqueness)
      const clientResult = await client.query(
        "INSERT INTO ClientID (email, name, company) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, company=EXCLUDED.company RETURNING client_id",
        [clientInfo.email, clientInfo.name, clientInfo.company]
      );
      const clientId = clientResult.rows[0].client_id;

      // Insert client intake info
      const intakeResult = await client.query(
        `INSERT INTO ClientIntake 
          (client_id, num_samples, site_sampling, sample_collector, reporting_unit_air, reporting_unit_surface, method, revision) 
         VALUES 
          ($1, $2, $3, $4, $5, $6, $7, $8) 
         RETURNING sbreport`,
        [
          clientId,
          clientInfo.numSamples,
          clientInfo.siteSampling || null,
          clientInfo.sampleCollector || null,
          clientInfo.reportingUnitAir || null,
          clientInfo.reportingUnitSurface || null,
          clientInfo.methodID,
          clientInfo.revision
        ]
      );
      const sbreport = intakeResult.rows[0].sbreport;

      // Get the next available SBID for this report
      const sbidResult = await client.query(
        "SELECT COALESCE(MAX(sbid), 0) + 1 AS next_sbid FROM SampleInfo WHERE sbreport = $1",
        [sbreport]
      );
      let nextSbid = sbidResult.rows[0].next_sbid;

      // Insert each sample into SampleInfo
      for (const sample of samples) {
        // Parse date to ensure proper format
        let parsedDate;
        try {
          parsedDate = new Date(sample.DateSampled);
          if (isNaN(parsedDate.getTime())) {
            throw new Error(`Invalid date format for sample "${sample.ClientName}"`);
          }
        } catch (error) {
          throw new Error(`Invalid date format for sample "${sample.ClientName}": ${error.message}`);
        }

        await client.query(
          `INSERT INTO SampleInfo (sbreport, sbid, client_assigned_name, air_volume, surface_area, date_sampled, mass)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            sbreport,
            nextSbid++,
            sample.ClientName,
            sample.AirVolume ? parseFloat(sample.AirVolume) : null,
            sample.SurfaceArea ? parseFloat(sample.SurfaceArea) : null,
            parsedDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
            sample.mass ? parseFloat(sample.mass) : null
          ]
        );
      }

      // Commit the transaction
      await client.query('COMMIT');

      res.status(201).json({ 
        success: true, 
        message: "Data successfully submitted!",
        reportId: sbreport
      });
      
    } catch (error) {
      // Rollback in case of error
      await client.query('ROLLBACK');
      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
    
  } catch (error) {
    console.error("Error in client sample intake:", error);
    
    // Determine if this is a database constraint violation
    if (error.code === '23514') { // Check constraint violation
      return res.status(400).json({ 
        success: false, 
        message: "Database constraint violation: " + (error.detail || error.message) 
      });
    }
    
    // Return appropriate error message
    res.status(500).json({ 
      success: false, 
      message: "Failed to process sample intake: " + (error.message || "Unknown error") 
    });
  }
});


// Route to get all unreported projects
app.get('/unreportedProjects', async (req, res) => {
  try {
    const query = `
      SELECT 
        ci.sbreport AS id,
        ci.sbreport AS sb,
        m.compound,
        ci.num_samples AS samples,
        cid.company AS customer,
        ari.date_received AS "receivedDate",
        ari.due_date AS "dueDate",
        ari.project_number AS "projectNumber",
        e.name AS chemist
      FROM 
        ClientIntake ci
      JOIN Methods m ON ci.method = m.method_number AND ci.revision = m.revision_number
      JOIN ClientID cid ON ci.client_id = cid.client_id
      LEFT JOIN AnalysisReporterInfo ari ON ci.sbreport = ari.sbreport
      LEFT JOIN EmployeeID e ON ari.preparer_id = e.employee_id
      WHERE 
        ari.date_reported IS NULL
      ORDER BY 
        CASE 
          WHEN ari.due_date IS NULL THEN 1
          ELSE 0
        END, 
        ari.due_date ASC,
        ci.sbreport DESC
    `;
    
    const result = await pool.query(query);
    
    // Format dates for frontend compatibility
    const projects = result.rows.map(project => ({
      ...project,
      receivedDate: formatDate(project.receivedDate),
      dueDate: formatDate(project.dueDate)
    }));
    
    res.json(projects);
  } catch (err) {
    console.error('Error fetching unreported projects:', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Route to update project number
app.post('/updateProject', async (req, res) => {
  const { sbreport, project_number } = req.body;
  
  if (!sbreport || project_number === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const query = `
      UPDATE AnalysisReporterInfo
      SET project_number = $1
      WHERE sbreport = $2
      RETURNING *
    `;
    
    const result = await pool.query(query, [project_number, sbreport]);
    
    if (result.rowCount === 0) {
      // If no row was updated, it might be because the record doesn't exist yet
      // Create a new record in AnalysisReporterInfo
      const insertQuery = `
        INSERT INTO AnalysisReporterInfo 
        (sbreport, num_samples_analyzed, conditions_upon_arrival, storage_conditions, analysis_unit, project_number)
        SELECT 
          $1,
          num_samples,
          'Not specified', 
          'Not specified',
          'ng',
          $2
        FROM ClientIntake
        WHERE sbreport = $1
        RETURNING *
      `;
      
      const insertResult = await pool.query(insertQuery, [sbreport, project_number]);
      
      if (insertResult.rowCount === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      
      res.json(insertResult.rows[0]);
    } else {
      res.json(result.rows[0]);
    }
  } catch (err) {
    console.error('Error updating project number:', err);
    res.status(500).json({ error: 'Failed to update project number' });
  }
});

// Route to set a project as received
app.post('/setReceived', async (req, res) => {
  const { sbreport, date_received, conditions, storage_location } = req.body;
  
  if (!sbreport || !date_received) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    // Check if the record exists in AnalysisReporterInfo
    const checkQuery = `
      SELECT * FROM AnalysisReporterInfo WHERE sbreport = $1
    `;
    
    const checkResult = await pool.query(checkQuery, [sbreport]);
    
    if (checkResult.rowCount === 0) {
      // Record doesn't exist, create a new one
      const insertQuery = `
        INSERT INTO AnalysisReporterInfo 
        (sbreport, num_samples_analyzed, conditions_upon_arrival, storage_conditions, analysis_unit, date_received)
        SELECT 
          $1,
          num_samples,
          $2, 
          $3,
          'ng',
          $4
        FROM ClientIntake
        WHERE sbreport = $1
        RETURNING *
      `;
      
      const insertResult = await pool.query(insertQuery, [
        sbreport, 
        conditions || 'Not specified', 
        storage_location || 'Not specified',
        date_received
      ]);
      
      if (insertResult.rowCount === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      
      res.json(insertResult.rows[0]);
    } else {
      // Record exists, update it
      const updateQuery = `
        UPDATE AnalysisReporterInfo
        SET 
          date_received = $1,
          conditions_upon_arrival = $2,
          storage_conditions = $3
        WHERE sbreport = $4
        RETURNING *
      `;
      
      const updateResult = await pool.query(updateQuery, [
        date_received,
        conditions || 'Not specified',
        storage_location || 'Not specified',
        sbreport
      ]);
      
      res.json(updateResult.rows[0]);
    }
  } catch (err) {
    console.error('Error setting project as received:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// Route to update chemist assigned to a project
app.post('/updateChemist', async (req, res) => {
  const { sbreport, chemist } = req.body;
  
  if (!sbreport || !chemist) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    // First, find the employee_id for the given chemist name
    const employeeQuery = `
      SELECT employee_id FROM EmployeeID WHERE name = $1
    `;
    
    const employeeResult = await pool.query(employeeQuery, [chemist]);
    
    // If chemist is 'N/A' or not found, use null for preparer_id
    const preparerId = chemist === 'N/A' ? null : 
                      (employeeResult.rowCount > 0 ? employeeResult.rows[0].employee_id : null);
    
    // Check if the record exists in AnalysisReporterInfo
    const checkQuery = `
      SELECT * FROM AnalysisReporterInfo WHERE sbreport = $1
    `;
    
    const checkResult = await pool.query(checkQuery, [sbreport]);
    
    if (checkResult.rowCount === 0) {
      // Record doesn't exist, create a new one
      const insertQuery = `
        INSERT INTO AnalysisReporterInfo 
        (sbreport, num_samples_analyzed, conditions_upon_arrival, storage_conditions, analysis_unit, preparer_id)
        SELECT 
          $1,
          num_samples,
          'Not specified', 
          'Not specified',
          'ng',
          $2
        FROM ClientIntake
        WHERE sbreport = $1
        RETURNING *
      `;
      
      const insertResult = await pool.query(insertQuery, [sbreport, preparerId]);
      
      if (insertResult.rowCount === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      
      res.json({ success: true, data: insertResult.rows[0] });
    } else {
      // Record exists, update it
      const updateQuery = `
        UPDATE AnalysisReporterInfo
        SET preparer_id = $1
        WHERE sbreport = $2
        RETURNING *
      `;
      
      const updateResult = await pool.query(updateQuery, [preparerId, sbreport]);
      
      res.json({ success: true, data: updateResult.rows[0] });
    }
  } catch (err) {
    console.error('Error updating chemist:', err);
    res.status(500).json({ error: 'Failed to update chemist' });
  }
});

// Route to get compound LOQ details
app.get('/compound/:compound', async (req, res) => {
  const { compound } = req.params;
  
  try {
    const query = `
      SELECT * FROM Methods 
      WHERE compound = $1
      ORDER BY method_number DESC, revision_number DESC
    `;
    
    const result = await pool.query(query, [compound]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Compound not found' });
    }
    
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching compound details:', err);
    res.status(500).json({ error: 'Failed to fetch compound details' });
  }
});

// Route to get all chemists
app.get('/chemists', async (req, res) => {
  try {
    const query = `
      SELECT employee_id, name FROM EmployeeID
      WHERE role = 'Chemist' OR role = 'Analyst'
      ORDER BY name
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching chemists:', err);
    res.status(500).json({ error: 'Failed to fetch chemists' });
  }
});

// Route to create a new project
app.post('/createProject', async (req, res) => {
  const { 
    client_id, 
    num_samples, 
    site_sampling, 
    sample_collector,
    reporting_unit_air,
    reporting_unit_surface,
    method,
    revision,
    due_date
  } = req.body;
  
  if (!client_id || !num_samples || !method || !revision) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Create the client intake record
    const clientIntakeQuery = `
      INSERT INTO ClientIntake 
      (client_id, num_samples, site_sampling, sample_collector, reporting_unit_air, reporting_unit_surface, method, revision)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING sbreport
    `;
    
    const clientIntakeValues = [
      client_id, 
      num_samples, 
      site_sampling || null, 
      sample_collector || null,
      reporting_unit_air || 'ng/m³',
      reporting_unit_surface || 'ng/cm²',
      method,
      revision
    ];
    
    const clientIntakeResult = await client.query(clientIntakeQuery, clientIntakeValues);
    const sbreport = clientIntakeResult.rows[0].sbreport;
    
    // 2. Create a basic analysis reporter record if a due date was provided
    if (due_date) {
      const analysisReporterQuery = `
        INSERT INTO AnalysisReporterInfo 
        (sbreport, num_samples_analyzed, conditions_upon_arrival, storage_conditions, analysis_unit, due_date)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      
      const analysisReporterValues = [
        sbreport,
        num_samples,
        'Not specified',
        'Not specified',
        'ng',
        due_date
      ];
      
      await client.query(analysisReporterQuery, analysisReporterValues);
    }
    
    await client.query('COMMIT');
    
    res.status(201).json({ 
      success: true,
      sbreport: sbreport
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  } finally {
    client.release();
  }
});

// Route to get project details
app.get('/project/:sbreport', async (req, res) => {
  const { sbreport } = req.params;
  
  try {
    const query = `
      SELECT 
        ci.sbreport,
        ci.num_samples,
        ci.site_sampling,
        ci.sample_collector,
        ci.reporting_unit_air,
        ci.reporting_unit_surface,
        ci.method,
        ci.revision,
        m.compound,
        cid.name AS client_name,
        cid.company AS client_company,
        ari.date_received,
        ari.due_date,
        ari.project_number,
        ari.conditions_upon_arrival,
        ari.storage_conditions,
        ari.extraction_date,
        ari.analysis_start_date,
        ari.analysis_end_date,
        ari.analysis_unit,
        e1.name AS preparer_name,
        e2.name AS reviewer_name
      FROM 
        ClientIntake ci
      JOIN Methods m ON ci.method = m.method_number AND ci.revision = m.revision_number
      JOIN ClientID cid ON ci.client_id = cid.client_id
      LEFT JOIN AnalysisReporterInfo ari ON ci.sbreport = ari.sbreport
      LEFT JOIN EmployeeID e1 ON ari.preparer_id = e1.employee_id
      LEFT JOIN EmployeeID e2 ON ari.reviewer_id = e2.employee_id
      WHERE ci.sbreport = $1
    `;
    
    const result = await pool.query(query, [sbreport]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    // Get sample information
    const samplesQuery = `
      SELECT * FROM SampleInfo
      WHERE sbreport = $1
      ORDER BY sbid
    `;
    
    const samplesResult = await pool.query(samplesQuery, [sbreport]);
    
    const projectData = {
      ...result.rows[0],
      samples: samplesResult.rows
    };
    
    res.json(projectData);
  } catch (err) {
    console.error('Error fetching project details:', err);
    res.status(500).json({ error: 'Failed to fetch project details' });
  }
});

app.listen(5500, () => {
  console.log("Server has started on port 5500");
  });

module.exports = app;