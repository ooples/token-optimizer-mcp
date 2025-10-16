/** * Smart Environment Variable Tool - 83% Token Reduction * * Features: * - Parse and validate .env files * - Detect missing required variables * - Cache env configs with 1-hour TTL * - Environment-specific suggestions (dev/staging/prod) * - Security issue detection (exposed secrets, weak configs) * - File hash-based invalidation */ import * as fs from "fs";
import * as path from "path";
