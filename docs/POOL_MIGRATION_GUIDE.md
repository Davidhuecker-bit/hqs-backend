# Migration Guide: Using Shared Database Pool

## Overview

This guide shows how to migrate existing services to use the new shared database pool configuration for better connection management.

## Benefits of Shared Pool

- ✅ **Controlled connection limits** - Prevents Railway connection exhaustion
- ✅ **Automatic timeout handling** - Releases idle connections after 30s
- ✅ **Fail-fast behavior** - 10s connection timeout
- ✅ **Centralized configuration** - One place to manage all pool settings
- ✅ **Graceful shutdown** - Helper functions for cleanup

## Before: Old Pattern

```javascript
// OLD: Each service creates its own pool
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// No timeout settings, no connection limits
// Pool is never closed on shutdown
```

## After: New Pattern

### Option 1: Use Shared Pool (Recommended for most services)

```javascript
// NEW: Use shared pool
const { getSharedPool } = require("../config/database");

const pool = getSharedPool();

// The shared pool has:
// - max: 10 connections
// - idleTimeoutMillis: 30000
// - connectionTimeoutMillis: 10000
// - Automatic error logging
```

### Option 2: Create Dedicated Pool (For services needing isolation)

```javascript
// NEW: Create configured pool
const { createPool } = require("../config/database");

const pool = createPool({ max: 5 });

// Or with custom config
const pool = createPool({
  max: 5,
  idleTimeoutMillis: 60000, // 1 minute
  connectionTimeoutMillis: 15000, // 15 seconds
});
```

## Migration Examples

### Example 1: Simple Service Migration

**Before** (`services/example.service.js`):
```javascript
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function getData() {
  const result = await pool.query("SELECT * FROM table");
  return result.rows;
}

module.exports = { getData };
```

**After** (`services/example.service.js`):
```javascript
const { getSharedPool } = require("../config/database");

const pool = getSharedPool();

async function getData() {
  const result = await pool.query("SELECT * FROM table");
  return result.rows;
}

module.exports = { getData };
```

**Changes:**
- ✅ Import from `config/database` instead of `pg`
- ✅ Call `getSharedPool()` instead of `new Pool(...)`
- ✅ Everything else stays the same

### Example 2: Service with Graceful Shutdown

**Before**:
```javascript
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function getData() {
  // ...
}

// No cleanup on shutdown
module.exports = { getData };
```

**After**:
```javascript
const { createPool, closePool } = require("../config/database");

const pool = createPool({ max: 5 });

async function getData() {
  // ...
}

async function shutdown() {
  await closePool(pool);
}

module.exports = { getData, shutdown };
```

Then in `server.js`:
```javascript
const exampleService = require("./services/example.service");

// On shutdown
process.on("SIGTERM", async () => {
  await exampleService.shutdown();
  // ... other cleanup
});
```

### Example 3: Job Script Migration

**Before** (`jobs/example.job.js`):
```javascript
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runJob() {
  // ... job logic
}

if (require.main === module) {
  runJob()
    .then(() => {
      console.log("Job completed");
      process.exit(0);
    })
    .catch(err => {
      console.error("Job failed:", err);
      process.exit(1);
    });
}
```

**After** (`jobs/example.job.js`):
```javascript
const { createPool, closePool } = require("../config/database");

const pool = createPool({ max: 3 }); // Jobs need fewer connections

async function runJob() {
  // ... job logic
}

if (require.main === module) {
  runJob()
    .then(async () => {
      console.log("Job completed");
      await closePool(pool); // ✅ Clean shutdown
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Job failed:", err);
      await closePool(pool); // ✅ Clean shutdown even on error
      process.exit(1);
    });
}
```

## When to Use Each Pattern

### Use Shared Pool When:
- ✅ Service makes occasional database queries
- ✅ Service doesn't need isolation
- ✅ Service is part of main application (not a job)
- ✅ You want simplest migration

**Examples:**
- `adminDemoPortfolio.service.js`
- `tableHealth.service.js`
- `marketNews.service.js`

### Use Dedicated Pool When:
- ✅ Service makes frequent queries
- ✅ Service needs connection isolation
- ✅ Background job scripts
- ✅ Services that need custom pool settings

**Examples:**
- `marketService.js` (high query volume)
- Jobs in `jobs/` directory
- `portfolioTwin.service.js` (long-running operations)

## Connection Pool Limits

### Railway PostgreSQL Limits

| Tier | Max Connections |
|------|----------------|
| Free | 20 |
| Hobby | 100 |
| Production | 400+ |

### Recommended Pool Sizes

```javascript
// Shared pool (used by most services)
getSharedPool() // max: 10

// High-volume services
createPool({ max: 10 })

// Normal services
createPool({ max: 5 })

// Background jobs
createPool({ max: 3 })

// One-off scripts
createPool({ max: 1 })
```

### Total Connection Calculation

Example with current architecture (20+ services):
- 1 shared pool × 10 = **10 connections**
- 5 high-volume services × 10 = **50 connections**
- 10 normal services × 5 = **50 connections**
- 5 job pools × 3 = **15 connections**

**Total: ~125 connections** (needs Hobby tier or higher)

## Testing Your Migration

### 1. Syntax Check

```bash
node --check services/your-service.js
```

### 2. Import Test

```javascript
// Create test file: test-import.js
const { getSharedPool } = require("./config/database");

const pool = getSharedPool();

pool.query("SELECT NOW()")
  .then(result => {
    console.log("✅ Pool works:", result.rows[0]);
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ Pool failed:", err);
    process.exit(1);
  });
```

```bash
# Run test
DATABASE_URL="your_db_url" node test-import.js
```

### 3. Integration Test

```bash
# Start server with migrated service
npm start

# Test the endpoint that uses the service
curl http://localhost:8080/api/your-endpoint

# Check for any connection errors in logs
```

## Rollback Plan

If you encounter issues:

1. **Revert the import:**
```javascript
// Change this back
const { getSharedPool } = require("../config/database");
const pool = getSharedPool();

// To this
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
```

2. **Check for pool-related errors:**
- "Sorry, too many clients already" → Reduce pool sizes
- "Connection timeout" → Increase `connectionTimeoutMillis`
- "ECONNREFUSED" → Check DATABASE_URL

3. **Monitor Railway metrics:**
- Check active connections in Railway dashboard
- Look for connection spikes
- Adjust pool sizes accordingly

## Best Practices

### DO ✅

- Use shared pool for most services
- Set appropriate `max` values for dedicated pools
- Always close pools in job scripts
- Test migrations in development first
- Monitor connection count in Railway

### DON'T ❌

- Create pools without size limits
- Leave pools open in job scripts
- Use huge pool sizes (max: 10 is usually enough)
- Share same pool instance across different concerns
- Forget to test after migration

## Migration Checklist

For each service/job you migrate:

- [ ] Import from `config/database` instead of `pg`
- [ ] Choose shared pool or dedicated pool
- [ ] Set appropriate `max` value if using dedicated pool
- [ ] Add graceful shutdown if needed
- [ ] Run syntax check: `node --check`
- [ ] Test the service/endpoint
- [ ] Check logs for errors
- [ ] Monitor Railway connection count
- [ ] Update any tests that mock the pool
- [ ] Document any special configuration

## FAQ

**Q: Should I migrate all services at once?**
A: No, migrate incrementally. Start with low-traffic services and test thoroughly.

**Q: What if I see "too many clients" errors?**
A: Reduce pool sizes. Check Railway dashboard for current connection count.

**Q: Can I mix old and new pool patterns?**
A: Yes, but not recommended long-term. Migrate systematically.

**Q: Do I need to change my SQL queries?**
A: No, only the pool initialization changes. Queries stay the same.

**Q: What about testing?**
A: Mock `getSharedPool()` or `createPool()` in your tests instead of `new Pool()`.

## Support

If you encounter issues:
1. Check Railway logs for connection errors
2. Run `npm run db:health` to verify database connectivity
3. Check `config/database.js` configuration
4. Monitor Railway metrics dashboard
5. Adjust pool sizes as needed

---

**Last Updated:** 2026-03-18  
**Backend Version:** 8.1.0
