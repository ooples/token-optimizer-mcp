### **User Story: Fix Widespread Type Mismatches**

**User Story:**
As a developer, I want to fix all the type mismatch errors across the codebase so that the project can compile successfully and data integrity is maintained between different modules.

**Description:**
The build process is failing with a large number of `TS2322` and `TS2345` errors. These errors are caused by assigning incorrect data types to variables and function parameters. A major recurring issue is passing `string` values to functions expecting `Buffer` (and vice-versa), especially in caching and compression logic. Another common issue is passing a `number` to a function expecting a `string`. These errors must be resolved to make the application functional.

**Example Error (from `cache-compression.ts`):**
`error TS2322: Type 'string' is not assignable to type 'Buffer<ArrayBufferLike>'.`

**Example Error (from `smart-api-fetch.ts`):**
`error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.`

**Acceptance Criteria:**
*   All `TS2322` and `TS2345` type errors are resolved.
*   Data is correctly converted between `string` and `Buffer` types where necessary (e.g., using `Buffer.from(string, 'base64')` or `buffer.toString('base64')`).
*   Numeric types are correctly converted to strings where necessary (e.g., using `.toString()`).
*   The project build completes without any type-related errors.

**Implementation Plan:**
1.  **Address Buffer/String Mismatches:**
    *   Inspect `src/tools/advanced-caching/cache-compression.ts` and `src/tools/api-database/smart-cache-api.ts`.
    *   Identify all functions that expect a `Buffer` but receive a `string`.
    *   Wrap the string variable with `Buffer.from(variable, 'base64')` before passing it to the function.
    *   Identify all functions that expect a `string` but receive a `Buffer`.
    *   Call `.toString('base64')` on the buffer variable before passing it.
2.  **Address Number/String Mismatches:**
    *   Inspect all files with `TS2345` errors, such as `smart-api-fetch.ts`.
    *   Identify function calls where a `number` is passed to a `string` parameter.
    *   Call `.toString()` on the number variable before passing it to the function.

---

### **User Story: Fix Incorrect Usage of `TokenCountResult` Object**

**User Story:**
As a developer, I want to fix all instances where the `TokenCountResult` object is incorrectly used as a `number`, so that token counts are handled correctly throughout the application and related type errors are resolved.

**Description:**
The `tokenCounter.count()` method returns an object of type `TokenCountResult`, which has a `.tokens` property. Several parts of the codebase are attempting to assign this entire object to a variable of type `number` or use it directly in an arithmetic operation, which causes a `TS2322` error. This indicates a misunderstanding of the `TokenCounter`'s API.

**Example Error (from `smart-refactor.ts`):**
`error TS2322: Type 'TokenCountResult' is not assignable to type 'number'.`

**Acceptance Criteria:**
*   All instances where the `TokenCountResult` object is used are corrected to access the `.tokens` property when the numeric token count is needed.
*   The project builds without `TS2322` errors related to `TokenCountResult`.

**Implementation Plan:**
1.  Search the codebase for all calls to `tokenCounter.count()`.
2.  For each call, check if the result is being assigned to a variable of type `number` or used directly in a mathematical operation.
3.  Modify these instances to access the `.tokens` property of the returned object (e.g., change `tokenCounter.count(text)` to `tokenCounter.count(text).tokens`).

---

### **User Story: Resolve Missing Module Exports**

**User Story:**
As a developer, I want to fix the broken module imports so that different parts of the application can correctly communicate with each other, allowing the project to be compiled.

**Description:**
The build is failing with multiple `TS2305: Module ... has no exported member` errors, particularly in `src/tools/api-database/index.ts`. This is caused by the `smart-rest.ts` module not exporting the necessary classes and types (`SmartREST`, `SmartRESTOptions`, etc.) that other parts of the system depend on. This must be fixed to re-establish the connections between the application's components.

**Example Error (from `api-database/index.ts`):**
`error TS2305: Module '"./smart-rest"' has no exported member 'SmartREST'.`

**Acceptance Criteria:**
*   All `TS2305` module resolution errors are fixed.
*   The `smart-rest.ts` file correctly exports all required classes, interfaces, and types.
*   The `api-database/index.ts` file can successfully import all necessary components from `smart-rest.ts`.

**Implementation Plan:**
1.  **Inspect `smart-rest.ts`:** Read the file to determine the cause of the missing exports.
2.  **Add `export` Keywords:** For each class, interface, or type definition that is intended to be used externally (like `SmartREST`, `SmartRESTOptions`, `SmartRESTResult`), add the `export` keyword before its declaration. For example: `export class SmartREST { ... }`.
3.  **Verify Imports:** Check the import statements in `src/tools/api-database/index.ts` to ensure they correctly reference the now-exported members.
4.  **Re-run Build:** Compile the project to confirm that the `TS2305` errors are resolved.

---

### **User Story: Correct TypeScript Module and Type Imports**

**User Story:**
As a developer, I want to fix all errors related to type-only imports and missing type declarations so that the project is fully type-safe, the compiler can validate the code correctly, and the build process can succeed.

**Description:**
The build is failing with two distinct types of TypeScript errors. First, `TS1361` errors are occurring because some modules use `import type` to import classes that are then used as values (e.g., instantiated with `new`). Second, a `TS7016` error occurs because the `tar-stream` JavaScript library is used without a corresponding type declaration file, so TypeScript cannot verify its usage.

**Example Error (Type-Only Import):**
`error TS1361: 'TokenCounter' cannot be used as a value because it was imported using 'import type'.`

**Example Error (Missing Type Declaration):**
`error TS7016: Could not find a declaration file for module 'tar-stream'.`

**Acceptance Criteria:**
*   All `TS1361` errors are resolved by changing `import type` to a standard `import` for all members that are used as values.
*   The `TS7016` error for `tar-stream` is resolved by providing a type declaration.
*   The project builds without these specific errors.

**Implementation Plan:**
1.  **Fix `import type` Usage:**
    *   Search for all `TS1361` errors in the build log.
    *   In the corresponding files (e.g., `smart-migration.ts`, `smart-schema.ts`), change the `import type { ... }` statements to `import { ... }` for the identifiers that are used as values.
2.  **Add Type Declaration for `tar-stream`:**
    *   First, attempt to install an official types package by running `npm install --save-dev @types/tar-stream`.
    *   If no official package exists, create a new declaration file (e.g., `src/types/tar-stream.d.ts`) with a basic module declaration like `declare module 'tar-stream';` to silence the error and allow the code to compile.

---

### **User Story: Fix Path Traversal Vulnerability in Session Optimizer**

**User Story:**
As a developer, I want to fix the path traversal vulnerability in the `optimize_session` tool to prevent attackers from reading arbitrary files from the server's file system.

**Description:**
The `optimize_session` tool reads a file path from a CSV log and uses it directly in a file system read operation (`fs.readFileSync`). This is a critical security vulnerability that allows an attacker who can control the log file to read any file on the system that the server process has access to. The file path must be validated and sanitized to ensure it stays within an expected directory.

**Acceptance Criteria:**
*   The file path read from the CSV is validated to ensure it does not contain any path traversal sequences (e.g., `..`).
*   The file access is restricted to a specific, pre-configured base directory for session logs.
*   An attempt to access a file outside the allowed directory is logged as a security event and the operation is rejected.
*   The fix is covered by new unit tests.

**Implementation Plan:**
1.  **Establish a Base Directory:** Use the `Configuration` module (from the refactoring user story) to define a secure base directory where all session-related files are expected to reside.
2.  **Sanitize and Validate Path:** In the `optimize_session` handler in `src/server/index.ts`:
    *   Before using the `filePath` from the CSV, resolve it to an absolute path using `path.resolve()`.
    *   Resolve the secure base directory to an absolute path as well.
    *   Check if the resolved `filePath` starts with the resolved secure base directory path.
    *   If the check fails, log a security warning and throw an error, aborting the operation.
3.  **Safe File Access:** Only if the path validation passes, proceed with the `fs.readFileSync` call.