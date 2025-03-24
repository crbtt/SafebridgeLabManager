const Pool = require("pg").Pool;

const pool = new Pool({
    user: "johncorbett",
    password: "",
    host: "localhost",
    port: 5432,
    database: "safebridge"
});

module.exports = pool;