### **User Story: Implement Semantic Caching**

**User Story:**
As a developer, I want the `CacheEngine` to support semantic caching, so that it can return cached results for prompts that are semantically similar, not just identical, dramatically improving the cache hit rate and token savings.

**Acceptance Criteria:**
*   The `CacheEngine` is integrated with an `IEmbeddingGenerator` and an `IVectorStore` (these will need to be created as part of a new RAG/VectorStore framework).
*   When a new prompt is to be cached, its vector embedding is generated and stored in the vector store, mapping the vector to the existing cache key.
*   When a cache lookup is performed, the system first checks for an exact match in the key-value cache.
*   If there is a miss, the system generates an embedding for the incoming prompt and performs a similarity search in the vector store.
*   If a semantically similar prompt is found above a configurable similarity threshold, its corresponding key is retrieved, and that key is used to fetch the result from the primary key-value cache.

**Implementation Plan:**
1.  **Develop Core Interfaces:** Create `IEmbeddingGenerator` and `IVectorStore` interfaces.
2.  **Implement Basic Components:** Create a simple `FoundationModelEmbeddingGenerator` and an `InMemoryVectorStore` for initial implementation and testing.
3.  **Integrate with CacheEngine:**
    *   Modify the `CacheEngine` constructor to accept an optional `IVectorStore` and `IEmbeddingGenerator`.
    *   Update the `set` method to generate and store an embedding in the vector store alongside the regular cache entry.
    *   Update the `get` method to perform the similarity search on a cache miss.

---

### **User Story: Implement Abstractive Summarization Module**

**User Story:**
As a developer, I want an abstractive summarization module for the optimizer, so that I can apply advanced, context-aware compression to prompts, yielding significantly higher token savings than generic algorithms like Brotli.

**Description:**
Generic compression is limited. By using a powerful language model to perform abstractive summarization, we can condense the core meaning of large text blocks (like previous conversation turns or large code snippets) into a much shorter form, leading to massive token savings while preserving essential context.

**Acceptance Criteria:**
*   A new `SummarizationModule.ts` is created in `src/modules`.
*   The module has a method like `summarize(text: string): Promise<string>` that uses an `IFoundationModel` to generate a summary.
*   The `TokenOptimizer` pipeline is updated to allow `SummarizationModule` to be used as an optimization strategy, configurable by the user.
*   The optimizer can be configured to apply summarization to specific parts of a prompt, identified by special markers (e.g., `<summarize>...</summarize>`).

**Implementation Plan:**
1.  **Create `SummarizationModule.ts`:** Implement the class, taking an `IFoundationModel` as a dependency.
2.  **Create `TokenOptimizer` (from bug_fixes):** Implement the core `TokenOptimizer` class that orchestrates different modules.
3.  **Integrate Module:** Modify the `TokenOptimizer` to allow a list of optimization modules to be configured. If the `SummarizationModule` is present, the optimizer will look for the special markers in the prompt and apply summarization accordingly.

---

### **User Story: Build an Extensible Plugin Architecture for Optimization Modules**

**User Story:**
As a developer, I want a proper plugin architecture for optimization modules, so that new optimization techniques can be easily created and added to the `TokenOptimizer` pipeline without modifying the core code.

**Description:**
The `src/modules` directory is currently empty. This user story proposes creating a formal plugin system. This would involve defining an `IOptimizationModule` interface and updating the core `TokenOptimizer` to process a chain of these modules. This makes the entire system extensible and future-proof.

**Acceptance Criteria:**
*   An `IOptimizationModule` interface is defined in `src/modules`. It must have a method like `apply(prompt: string): Promise<OptimizationResult>`.
*   The `TokenOptimizer` class is refactored to accept an array of `IOptimizationModule` instances in its constructor.
*   The `TokenOptimizer.optimize` method is updated to execute each module in the provided order, passing the output of one module as the input to the next.
*   The existing `CompressionEngine` logic is wrapped in a new `CompressionModule` that implements `IOptimizationModule`.
*   The new `SummarizationModule` also implements `IOptimizationModule`.

**Implementation Plan:**
1.  **Define Interface:** Create `src/modules/IOptimizationModule.ts`.
2.  **Refactor TokenOptimizer:** Change the `TokenOptimizer` to use a chain-of-responsibility pattern, executing a list of modules.
3.  **Create Concrete Modules:** Create `CompressionModule.ts` and refactor the `SummarizationModule.ts` to conform to the new interface.