# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.0.2](https://github.com/ooples/token-optimizer-mcp/compare/v6.0.1...v6.0.2) (2026-08-28)


### Bug Fixes

* bound file traversal so smart_glob and smart_grep cannot hang ([#336](https://github.com/ooples/token-optimizer-mcp/issues/336)) ([21d6fb1](https://github.com/ooples/token-optimizer-mcp/commit/21d6fb15da852878fd5e983eda46442a13dae69a))
* **launch:** stop the refresh deleting the runtime a live session is using ([#337](https://github.com/ooples/token-optimizer-mcp/issues/337)) ([ad440c6](https://github.com/ooples/token-optimizer-mcp/commit/ad440c638441dc426cac2444dd020fc24cf99ff0))
* **lint:** record the sync calls that arrived with the runtime loader ([#341](https://github.com/ooples/token-optimizer-mcp/issues/341)) ([0ef6d9e](https://github.com/ooples/token-optimizer-mcp/commit/0ef6d9e18a2eb4c52869cb6257ff7e0d4e925048))


### Performance

* **analysis:** read each file once instead of two or three times ([#338](https://github.com/ooples/token-optimizer-mcp/issues/338)) ([bf3f259](https://github.com/ooples/token-optimizer-mcp/commit/bf3f259d71efecaebbecc30c6a55bd3e56341802))

## [6.0.1](https://github.com/ooples/token-optimizer-mcp/compare/v6.0.0...v6.0.1) (2026-08-28)


### Bug Fixes

* **plugin:** warm-launch shim to end npx cold-start MCP timeouts ([#333](https://github.com/ooples/token-optimizer-mcp/issues/333)) ([5feffd0](https://github.com/ooples/token-optimizer-mcp/commit/5feffd057fc7f0d2b066738ba6f2b3238e12e654))

## [6.0.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.8.0...v6.0.0) (2026-08-27)


### ⚠ BREAKING CHANGES

* hooks now install automatically on global install users upgrading should restart claude code/desktop after npm update
* None - this is the initial stable release

### Features

* add auto-updating savings data to current-session.txt (issue [#113](https://github.com/ooples/token-optimizer-mcp/issues/113)) ([#115](https://github.com/ooples/token-optimizer-mcp/issues/115)) ([04097dd](https://github.com/ooples/token-optimizer-mcp/commit/04097dd8bed9444b95849a190a32e69068a0f56f))
* add automatic hook installation on npm install ([708b823](https://github.com/ooples/token-optimizer-mcp/commit/708b8232d4204aa6f91e53d21aea7f83ac803983))
* add causal evidence and cross-client effectiveness ([#301](https://github.com/ooples/token-optimizer-mcp/issues/301)) ([59656c2](https://github.com/ooples/token-optimizer-mcp/commit/59656c2c64399165157ad2ba6564fef5a0991798))
* Add CLI wrapper for PowerShell hooks integration with stdin support ([abafd45](https://github.com/ooples/token-optimizer-mcp/commit/abafd45820da246c7b291a9bab83767c5db13e0f))
* add comprehensive validation system for all 67 tools ([#109](https://github.com/ooples/token-optimizer-mcp/issues/109)) ([7c5a5d2](https://github.com/ooples/token-optimizer-mcp/commit/7c5a5d20ae81804fca18f1824760b4cf2f0981ad))
* add cross-platform installation support with automated installers ([#85](https://github.com/ooples/token-optimizer-mcp/issues/85)) ([b53c8fd](https://github.com/ooples/token-optimizer-mcp/commit/b53c8fdb942d1bd741fb822171dd54e5bda7e6dd))
* add executable UCR effectiveness proof program ([#304](https://github.com/ooples/token-optimizer-mcp/issues/304)) ([1e5def5](https://github.com/ooples/token-optimizer-mcp/commit/1e5def52ea3bc5a92f26884e4a17994f35049f54))
* Add mcpName field for MCP Registry ([b71a08d](https://github.com/ooples/token-optimizer-mcp/commit/b71a08dfc508200ad055a088b3078159f5761b4f))
* add native optimization hooks across cli tools ([#197](https://github.com/ooples/token-optimizer-mcp/issues/197)) ([ac35492](https://github.com/ooples/token-optimizer-mcp/commit/ac354921de8faeb42e9d00014d0b1328dfc98148))
* **analytics:** auto-record token savings + add get_optimization_report ([#181](https://github.com/ooples/token-optimizer-mcp/issues/181)) ([2b26227](https://github.com/ooples/token-optimizer-mcp/commit/2b2622738adf664e4c3d4d5a2e608d723a6bc040))
* bump version to 2.12.0 for code-analysis tools release ([12c4c13](https://github.com/ooples/token-optimizer-mcp/commit/12c4c1374cbe6a892b1018b720305b01dd73368e))
* establish code quality standards with eslint and prettier ([#91](https://github.com/ooples/token-optimizer-mcp/issues/91)) ([4516710](https://github.com/ooples/token-optimizer-mcp/commit/451671010397f521b657d3bc4d2e0ba303c2e192))
* **graph:** add wiki_read so agents can retrieve what the graph knows ([#281](https://github.com/ooples/token-optimizer-mcp/issues/281)) ([23f8250](https://github.com/ooples/token-optimizer-mcp/commit/23f8250d5f1df388d5c66fa1c61e603c4ee88fda))
* **graph:** carry process lessons across projects ([#278](https://github.com/ooples/token-optimizer-mcp/issues/278)) ([7c6bedd](https://github.com/ooples/token-optimizer-mcp/commit/7c6bedd2f30e4544e4233439de96bc395d688b5f))
* **graph:** make the knowledge loop actually run -- harvest by default, and enforce recording ([#296](https://github.com/ooples/token-optimizer-mcp/issues/296)) ([8a7ebce](https://github.com/ooples/token-optimizer-mcp/commit/8a7ebce623a8a420f1f231d715da5dd21032d37d))
* **hooks:** ask the running session to record what it worked out ([#264](https://github.com/ooples/token-optimizer-mcp/issues/264)) ([dc39357](https://github.com/ooples/token-optimizer-mcp/commit/dc39357ca8f90bcdbc1781036d44478178831a49))
* **hooks:** wire co-occurrence to restoration, so the graph can predict ([#240](https://github.com/ooples/token-optimizer-mcp/issues/240)) ([41e422f](https://github.com/ooples/token-optimizer-mcp/commit/41e422fbdc76a2cae6c9aae6f264453670ee89f2))
* implement 3 dashboard stub tools using gemini cli code generation ([#84](https://github.com/ooples/token-optimizer-mcp/issues/84)) ([488d0dd](https://github.com/ooples/token-optimizer-mcp/commit/488d0dd69392a1436924727b5178909f13aa143f))
* implement 6 intelligence stub tools with cache integration ([#83](https://github.com/ooples/token-optimizer-mcp/issues/83)) ([d1eada7](https://github.com/ooples/token-optimizer-mcp/commit/d1eada7fc10ea8c21f3077d3a709ec3bb601398a))
* implement abstractive summarization module with comprehensive tests ([#92](https://github.com/ooples/token-optimizer-mcp/issues/92)) ([9fb448a](https://github.com/ooples/token-optimizer-mcp/commit/9fb448a3bdbc187d04a458a19b50e9d214048d6a))
* implement background optimization with immediate session persistence ([770cf31](https://github.com/ooples/token-optimizer-mcp/commit/770cf3164a9010d90e1848672b3b257e20889fd2))
* implement dynamic import for optional compression packages ([#93](https://github.com/ooples/token-optimizer-mcp/issues/93)) ([f870a31](https://github.com/ooples/token-optimizer-mcp/commit/f870a31fd9d211dad4d326a530e64ef5957da503))
* implement extensible plugin architecture for optimization modules ([#95](https://github.com/ooples/token-optimizer-mcp/issues/95)) ([b270ba1](https://github.com/ooples/token-optimizer-mcp/commit/b270ba1bc65e17c449db38710e050711f9e80762))
* implement granular per-hook/per-action/per-mcp-server token analytics ([#114](https://github.com/ooples/token-optimizer-mcp/issues/114)) ([3d1cacc](https://github.com/ooples/token-optimizer-mcp/commit/3d1cacc146299ff85b7749b6f2680fdbdb5f67ea))
* implement LRU cache and sophisticated token counting (issues [#4](https://github.com/ooples/token-optimizer-mcp/issues/4) and [#5](https://github.com/ooples/token-optimizer-mcp/issues/5)) ([#127](https://github.com/ooples/token-optimizer-mcp/issues/127)) ([3f069f7](https://github.com/ooples/token-optimizer-mcp/commit/3f069f7ce82ed9f25ca30d8c9ad154425090f63d))
* implement semantic caching with vector store for improved cache hit rates ([#94](https://github.com/ooples/token-optimizer-mcp/issues/94)) ([3ec40fd](https://github.com/ooples/token-optimizer-mcp/commit/3ec40fd85af8725821c1e9ee8207f1e45109a96f))
* implement smart-workflow configuration tool with full functionality ([#82](https://github.com/ooples/token-optimizer-mcp/issues/82)) ([eb2023d](https://github.com/ooples/token-optimizer-mcp/commit/eb2023d3f69e94d63d92eae58a2e96473498de59))
* implement universal cognitive runtime evidence system ([#303](https://github.com/ooples/token-optimizer-mcp/issues/303)) ([ef34b71](https://github.com/ooples/token-optimizer-mcp/commit/ef34b715fbe1b134d07cf930cd2b4450566a6dc5))
* **inject:** deliver findings to the model, and measure whether it helps ([#235](https://github.com/ooples/token-optimizer-mcp/issues/235)) ([e1f6d2f](https://github.com/ooples/token-optimizer-mcp/commit/e1f6d2f05ea4f4ac559f71841809a1712bc1a54e))
* Integrate Hypercontext Tools with Phase 1 Bug Fixes ([5b22476](https://github.com/ooples/token-optimizer-mcp/commit/5b22476fa4689aac1218e650106e494123c4805b))
* **lessons:** capture user corrections and deliver them back as instructions ([#236](https://github.com/ooples/token-optimizer-mcp/issues/236)) ([f2fa046](https://github.com/ooples/token-optimizer-mcp/commit/f2fa046a97dc13907d6bdcc0dddb8159336e1c93))
* optimization platform — config, tokenizers, LRU cache, sessions, context-delta ([#163](https://github.com/ooples/token-optimizer-mcp/issues/163)) ([b316152](https://github.com/ooples/token-optimizer-mcp/commit/b3161526b031adec6a30e575c7152b5e7b69f4ec))
* optimize tokens by default on install, across all 15 CLI clients ([#203](https://github.com/ooples/token-optimizer-mcp/issues/203)) ([44d633b](https://github.com/ooples/token-optimizer-mcp/commit/44d633b1ba4a5cb862d5ac3f0251351c4605b147))
* **packaging:** claude code plugin + gemini/codex/opencode/copilot integrations ([#180](https://github.com/ooples/token-optimizer-mcp/issues/180)) ([a694fc1](https://github.com/ooples/token-optimizer-mcp/commit/a694fc1ac5da917f24ef54579d50f59919fccad0))
* production-ready deduplication module ([#99](https://github.com/ooples/token-optimizer-mcp/issues/99)) ([242e3db](https://github.com/ooples/token-optimizer-mcp/commit/242e3db2969d6c8d18e49005bba7ec984089af82))
* register 11 advanced caching and monitoring tools ([#71](https://github.com/ooples/token-optimizer-mcp/issues/71)) ([89860ec](https://github.com/ooples/token-optimizer-mcp/commit/89860ecf4b82ec82606e065eb380e9de32166261))
* register 12 build systems and system operations tools ([#70](https://github.com/ooples/token-optimizer-mcp/issues/70)) ([093bdbf](https://github.com/ooples/token-optimizer-mcp/commit/093bdbfe3c656356af48b03a970108d0460ee551))
* register 14 code analysis and configuration tools ([#72](https://github.com/ooples/token-optimizer-mcp/issues/72)) ([ad062f7](https://github.com/ooples/token-optimizer-mcp/commit/ad062f78a3e5ca3c180ca37ad0f7412a4d5d059a))
* register 2 intelligence and AI tools ([#76](https://github.com/ooples/token-optimizer-mcp/issues/76)) ([add9755](https://github.com/ooples/token-optimizer-mcp/commit/add9755284cbbef541b51e1eab0efeafe4223a04))
* register 4 dashboard and monitoring tools ([#77](https://github.com/ooples/token-optimizer-mcp/issues/77)) ([39fcc10](https://github.com/ooples/token-optimizer-mcp/commit/39fcc109e53d54179753b2fba41df49f89549f70))
* register 5 file-operations tools (smart-edit, smart-glob, smart-grep, smart-read, smart-write) ([#80](https://github.com/ooples/token-optimizer-mcp/issues/80)) ([e78e7c5](https://github.com/ooples/token-optimizer-mcp/commit/e78e7c5c69d0173d14ffba1484261cc1551945ef))
* register 8 code-analysis tools ([#79](https://github.com/ooples/token-optimizer-mcp/issues/79)) ([047af11](https://github.com/ooples/token-optimizer-mcp/commit/047af11167dd1a3c878d8a82f7e45213835eb35a))
* register 8 code-analysis tools (complexity, dependencies, exports, imports, refactor, security, symbols, typescript) ([#78](https://github.com/ooples/token-optimizer-mcp/issues/78)) ([a147bfb](https://github.com/ooples/token-optimizer-mcp/commit/a147bfb9374fcbc09c4fc9395a3fc6ef7a1185c5))
* Register Advanced Caching and API/Database tools ([#65](https://github.com/ooples/token-optimizer-mcp/issues/65)) ([71e610f](https://github.com/ooples/token-optimizer-mcp/commit/71e610f6233aeb431da2bb8e26dfaa2dc8e63829))
* Release v0.2.0 with comprehensive test suite ([822f110](https://github.com/ooples/token-optimizer-mcp/commit/822f1102a6a37e64205e33a710d92ce106cde2fa))
* **US-CI-001:** Establish code quality standards ([f20fc29](https://github.com/ooples/token-optimizer-mcp/commit/f20fc29b413c3355c280256dc54ca2d893b21999))
* **US-CI-001:** Establish code quality standards ([3638681](https://github.com/ooples/token-optimizer-mcp/commit/3638681fe49211777bbd362b4ec88a5e3aa24b24))
* **US-CI-005:** Improve SmartDatabase output formatting ([0bd127c](https://github.com/ooples/token-optimizer-mcp/commit/0bd127c1f43a9ff9b9ca55f038a9354d5e5b9de0))
* **US-CI-008:** Improve SmartSQL output formatting ([44b4993](https://github.com/ooples/token-optimizer-mcp/commit/44b49931beee8342080c85b5998e7aa9f63d47e0))
* **US-CI-008:** Improve SmartSQL output formatting ([8228275](https://github.com/ooples/token-optimizer-mcp/commit/82282751fc8062b22f16b3b17309f318cd5ac71a))
* **US-NF-001:** Implement real-time CLI integration for token tracking ([117a4cd](https://github.com/ooples/token-optimizer-mcp/commit/117a4cd30cd519b2f3ff1cc850f8a54f00732324))
* **US-NF-001:** Implement real-time CLI integration for token tracking ([78bab51](https://github.com/ooples/token-optimizer-mcp/commit/78bab516eaf072dd8d3e64c1739da0c2ab4866a4))
* **US-NF-002:** Enhance session analytics ([27d7553](https://github.com/ooples/token-optimizer-mcp/commit/27d7553fe08ea31454ff368813395a543163841a))
* **US-NF-002:** Enhance session analytics with token usage trends and tool call patterns ([ac642f1](https://github.com/ooples/token-optimizer-mcp/commit/ac642f183bdad0a6fafd09d779358af0e702bfec))
* **US-NF-002:** Enhance session analytics with token usage trends and tool call patterns ([030bd1b](https://github.com/ooples/token-optimizer-mcp/commit/030bd1b8d02ede3c84db23ecd7f87270993b69d8))
* **US-NF-002:** Enhance session analytics with trends ([d068e2d](https://github.com/ooples/token-optimizer-mcp/commit/d068e2d3dab3ed12920b71576998fd44ea7be08a))
* **US-NF-002:** Implement abstractive summarization ([2440ef4](https://github.com/ooples/token-optimizer-mcp/commit/2440ef49eb2704dce954fc3c47c45943651aa8db))
* **US-NF-002:** Implement abstractive summarization ([99b5b5f](https://github.com/ooples/token-optimizer-mcp/commit/99b5b5f84d07f3d146213fdbbf62a1f26a635790))
* **US-NF-003:** Implement automatic caching of high-token operations and dynamic cache warming ([b69f477](https://github.com/ooples/token-optimizer-mcp/commit/b69f47727448a7d5361e60147474cb5009aede0c))
* **US-NF-003:** Implement automatic caching of high-token operations and dynamic cache warming ([cd46558](https://github.com/ooples/token-optimizer-mcp/commit/cd4655829917d808dd6f4c81fb2d8597a7952790))
* **US-NF-004:** Implement multi-session analysis for project-level token usage ([e7cee48](https://github.com/ooples/token-optimizer-mcp/commit/e7cee48a591f8726122539996f8c3e56bc4ae033))
* **US-NF-004:** Implement multi-session analysis for project-level token usage and cost estimation ([876f65d](https://github.com/ooples/token-optimizer-mcp/commit/876f65ddb2f0da87c62063765e685f8382454d64))
* **US-NF-005:** Implement web-based dashboard UI for session visualization ([90e3a4b](https://github.com/ooples/token-optimizer-mcp/commit/90e3a4b8d2719cf027e8079510ac41521ee1c60e))
* **US-NF-005:** Implement web-based dashboard UI for session visualization ([051f274](https://github.com/ooples/token-optimizer-mcp/commit/051f27474d85d7f3299b56fc61bfcb0666a4e198))
* **wiki:** a finding reaches every identical copy of its file ([#327](https://github.com/ooples/token-optimizer-mcp/issues/327)) ([9a016b6](https://github.com/ooples/token-optimizer-mcp/commit/9a016b6d23250b5ea7df4505305cc700fdea0c5e))
* **wiki:** harvest at precompact, and report the hit rate beside the balance ([#329](https://github.com/ooples/token-optimizer-mcp/issues/329)) ([ae6d53e](https://github.com/ooples/token-optimizer-mcp/commit/ae6d53eecd35da714a23a4d1bfb7fec639757357))
* **wiki:** produce findings and measure whether they pay ([#204](https://github.com/ooples/token-optimizer-mcp/issues/204), part 2 of 3) ([#328](https://github.com/ooples/token-optimizer-mcp/issues/328)) ([e672c13](https://github.com/ooples/token-optimizer-mcp/commit/e672c139fccd9c466b5cf23c1d5e5a2e6b2f2132))


### Bug Fixes

* a fresh windows clone failed its own test suite and format check ([#220](https://github.com/ooples/token-optimizer-mcp/issues/220)) ([9709c12](https://github.com/ooples/token-optimizer-mcp/commit/9709c12db8f689bd4961989b8f31375052db0d88))
* **adapter:** make the non-Claude clients measure what the router measures ([#284](https://github.com/ooples/token-optimizer-mcp/issues/284)) ([d1fbf2a](https://github.com/ooples/token-optimizer-mcp/commit/d1fbf2ab182dc6abbd8af52cf9a460afe1dedd0e))
* add .js extensions to file-operations imports for node esm compatibility ([#69](https://github.com/ooples/token-optimizer-mcp/issues/69)) ([6595aa4](https://github.com/ooples/token-optimizer-mcp/commit/6595aa44019189dff33d29d7140bf60736984206))
* Add async I/O with timeout to prevent stdin hanging in wrapper ([922217e](https://github.com/ooples/token-optimizer-mcp/commit/922217e7f72fb46b8038fc6440ab062a0fe3b215))
* add explicit comment showing Get-CacheHitRate usage (iteration 3) ([e8b84a0](https://github.com/ooples/token-optimizer-mcp/commit/e8b84a0890338876fdd9a837fb76081d874461da))
* add missing glob dependency causing module not found errors ([bc58820](https://github.com/ooples/token-optimizer-mcp/commit/bc58820d585ba3e792f2c53fac197fb7813040e1))
* add missing items schema to array tool parameters ([#153](https://github.com/ooples/token-optimizer-mcp/issues/153)) ([#154](https://github.com/ooples/token-optimizer-mcp/issues/154)) ([06b941f](https://github.com/ooples/token-optimizer-mcp/commit/06b941f1b65f85758f1efa16839c0629826a61d0))
* add null safety checks for 10 undefined accesses (US-BF-003) ([68bd2b9](https://github.com/ooples/token-optimizer-mcp/commit/68bd2b973b58c80fe49e0d106b1cbd9430a5c3d1))
* add null safety checks for 10 undefined accesses (US-BF-003) ([463d24a](https://github.com/ooples/token-optimizer-mcp/commit/463d24a0689275840440b1820d13a017341d2131))
* add null safety checks for 10 undefined accesses (US-BF-003) ([541fcd4](https://github.com/ooples/token-optimizer-mcp/commit/541fcd44732a110f4a98d2af399d41e9b0b222b1))
* add semantic-release git plugin and sync package.json to v5.0.1 ([#119](https://github.com/ooples/token-optimizer-mcp/issues/119)) ([31efcf3](https://github.com/ooples/token-optimizer-mcp/commit/31efcf3deb26002eacc979650b0f2e3b04bdcc2f))
* address 2 remaining Copilot review comments ([ab06f64](https://github.com/ooples/token-optimizer-mcp/commit/ab06f6419cf7ba08643d7c7eb28cbb20474cd27c))
* Address all Copilot review comments on caching implementation ([fc57eb6](https://github.com/ooples/token-optimizer-mcp/commit/fc57eb6422e29853476e3462647c2ed2c8b89525))
* Address all Copilot review comments on project analysis ([ec12395](https://github.com/ooples/token-optimizer-mcp/commit/ec123953a5fec42ea6d00b5cc27946703483f5cd))
* address contradictory Copilot feedback with explicit checks ([5b00b35](https://github.com/ooples/token-optimizer-mcp/commit/5b00b35693183230698ad59b3c62a7b777b9e461))
* Address Copilot review comments on async I/O implementation ([599da6a](https://github.com/ooples/token-optimizer-mcp/commit/599da6a8d62cfee07976613c53a35029315b77ae))
* address Copilot review comments on null safety ([9242412](https://github.com/ooples/token-optimizer-mcp/commit/9242412ecd10def3a55049ed5316ebe1a7937656))
* Address GitHub Copilot code review comments ([7e60407](https://github.com/ooples/token-optimizer-mcp/commit/7e6040786fa54563fe9888acd03b397fee1f17ae))
* address GitHub Copilot review comments (iteration 2) ([5d37177](https://github.com/ooples/token-optimizer-mcp/commit/5d37177ff83d7befdacf7a4483b5d8ca3fc85642))
* Address GitHub Copilot review feedback for PR [#6](https://github.com/ooples/token-optimizer-mcp/issues/6) ([ed4ada8](https://github.com/ooples/token-optimizer-mcp/commit/ed4ada8b5f1e740dc9cb9dad5820ffcd1d4acc96))
* Address GitHub Copilot review feedback for PRs [#4](https://github.com/ooples/token-optimizer-mcp/issues/4) and [#6](https://github.com/ooples/token-optimizer-mcp/issues/6) ([ada4fa9](https://github.com/ooples/token-optimizer-mcp/commit/ada4fa9227aa034a8268e5c27a5228317ac4a53d))
* Address GitHub Copilot review feedback for PRs [#4](https://github.com/ooples/token-optimizer-mcp/issues/4) and [#6](https://github.com/ooples/token-optimizer-mcp/issues/6) ([0081f3e](https://github.com/ooples/token-optimizer-mcp/commit/0081f3ebe14ac81778461292094363b346ffa68b))
* **audit:** stop the report misstating its own numbers ([#286](https://github.com/ooples/token-optimizer-mcp/issues/286)) ([7a6f4be](https://github.com/ooples/token-optimizer-mcp/commit/7a6f4be8d55655800fded2c2f63702e996b0f34c))
* **build:** resolve typescript compilation errors ([bbe7aca](https://github.com/ooples/token-optimizer-mcp/commit/bbe7acaec11591986babaeb3824041103f50077a))
* **cache:** correct cache.set() parameters in smart-read.ts ([c2b1fac](https://github.com/ooples/token-optimizer-mcp/commit/c2b1facfd06afe2e0ac5bde978d8807ac3636efa))
* **cache:** handle uncompressed data in get_cached tool ([#64](https://github.com/ooples/token-optimizer-mcp/issues/64)) ([4117548](https://github.com/ooples/token-optimizer-mcp/commit/41175483816ede47901f8bd752bb9c112e58010c))
* **cache:** original and compressed sizes were recorded backwards ([#227](https://github.com/ooples/token-optimizer-mcp/issues/227)) ([74f16c6](https://github.com/ooples/token-optimizer-mcp/commit/74f16c6b98862c7a34c4770d45181ddbaf9196e2))
* **cache:** self-heal from a corrupt database file on every retry ([#188](https://github.com/ooples/token-optimizer-mcp/issues/188)) ([4b415ea](https://github.com/ooples/token-optimizer-mcp/commit/4b415ea73a4fca4ebde391ba8e05a42390b49af0))
* **cache:** stop reporting invented cache costs ([#282](https://github.com/ooples/token-optimizer-mcp/issues/282)) ([7ad35b0](https://github.com/ooples/token-optimizer-mcp/commit/7ad35b08dc6dc2868b7b939566d425305176190c))
* **cache:** tolerate a directory passed as the cache engine db path ([#171](https://github.com/ooples/token-optimizer-mcp/issues/171)) ([d933821](https://github.com/ooples/token-optimizer-mcp/commit/d9338213fb5c2264d67b9ed3f74bf48b226bd601))
* **cache:** update cache.set() parameter names and fix method calls ([a8fc3ff](https://github.com/ooples/token-optimizer-mcp/commit/a8fc3ff519d1f8e4596ac83b42b4680dbb62d994))
* change buffer encoding from utf-8 to base64 for binary data (gzip and images) ([994a72c](https://github.com/ooples/token-optimizer-mcp/commit/994a72ccde2eac8a792e360cb2cb50265f991463))
* **ci,security:** repair release pipeline (Node 22) and stop tracking .mcp.json ([#179](https://github.com/ooples/token-optimizer-mcp/issues/179)) ([73550bc](https://github.com/ooples/token-optimizer-mcp/commit/73550bcd401adf0554e228f1abaeb87e5b464631))
* **ci:** correct build artifact verification path from dist/index.js to dist/server/index.js ([4225170](https://github.com/ooples/token-optimizer-mcp/commit/42251708797048871c8b374dd8d082b528933baa))
* **ci:** let release PRs satisfy required checks instead of skipping them ([#206](https://github.com/ooples/token-optimizer-mcp/issues/206)) ([97daa05](https://github.com/ooples/token-optimizer-mcp/commit/97daa05d1fe324744499ef445afb81ffadc09722))
* **ci:** let the release-pin sync be triggered manually ([#244](https://github.com/ooples/token-optimizer-mcp/issues/244)) ([16fc1c5](https://github.com/ooples/token-optimizer-mcp/commit/16fc1c5061bfccb9f4d7d32f85552cd39cdb8344))
* **ci:** remove continue-on-error and add proper debugging to commitlint ([0520469](https://github.com/ooples/token-optimizer-mcp/commit/052046980f1f8946ffeadd6e52e1d5b4e4c97eb0))
* **ci:** resolve commitlint and performance benchmarks workflow failures ([25cd739](https://github.com/ooples/token-optimizer-mcp/commit/25cd7390cb8e89c71755acde0a9ff95cbd903322))
* **ci:** run every verification gate, and repair the four that had rotted ([#272](https://github.com/ooples/token-optimizer-mcp/issues/272)) ([e02bce1](https://github.com/ooples/token-optimizer-mcp/commit/e02bce1bf65ec337206f533a7f62763a24104104))
* consolidate every live-test fix into one verified release ([#217](https://github.com/ooples/token-optimizer-mcp/issues/217)) ([ea8d1aa](https://github.com/ooples/token-optimizer-mcp/commit/ea8d1aa1b11ca8a6a180362fe53d3a3a898ca033))
* **consolidate:** score against the inputs the module says it uses ([#285](https://github.com/ooples/token-optimizer-mcp/issues/285)) ([b10eba0](https://github.com/ooples/token-optimizer-mcp/commit/b10eba0e7ab6b84dabd04ca3af039285937b6ee8))
* correct branch name in install-hooks script from main to master ([#104](https://github.com/ooples/token-optimizer-mcp/issues/104)) ([14ddecd](https://github.com/ooples/token-optimizer-mcp/commit/14ddecd203f3cb8c5b42f87d05e827cb490ed74a))
* correct glob import syntax for ES modules ([33ebfb9](https://github.com/ooples/token-optimizer-mcp/commit/33ebfb98892fe77bf9f2c52f2a531172041821b0))
* correct parameter order in CacheEngine.set() call ([c7471b6](https://github.com/ooples/token-optimizer-mcp/commit/c7471b6a091785aed68f7e9d007063254b492482))
* create cache-helper and fix cache.set() parameter mismatches ([493929b](https://github.com/ooples/token-optimizer-mcp/commit/493929b614d87e5d18f2bf5d9cf1ce81f0009f06))
* **critical:** Prevent token increase on small files ([118c14d](https://github.com/ooples/token-optimizer-mcp/commit/118c14dcbb1243b65b0b076b3b38901b09272d62))
* **critical:** Prevent token increase on small files and update version to 0.2.0 ([f7d1b7b](https://github.com/ooples/token-optimizer-mcp/commit/f7d1b7bc2750b4a4fcc564a4ad8071adc7af98d9))
* **curate:** a correction claimed to be a person's assertion ([#232](https://github.com/ooples/token-optimizer-mcp/issues/232)) ([5d822f3](https://github.com/ooples/token-optimizer-mcp/commit/5d822f38706d42ad7aadfa8f942b7bc936ce31f5))
* **curate:** stop losing curated claims to a single failed append ([#283](https://github.com/ooples/token-optimizer-mcp/issues/283)) ([6f66b55](https://github.com/ooples/token-optimizer-mcp/commit/6f66b55d2a5c1a8d2aabfac370ddf7e5516bf57f))
* **dashboard:** repair wiki route and plugin activity status ([#313](https://github.com/ooples/token-optimizer-mcp/issues/313)) ([d6fcc24](https://github.com/ooples/token-optimizer-mcp/commit/d6fcc2432dd291acba184d35ec72a2b16d1ad220))
* **decide:** a dump redirected to a file is not a dump ([#298](https://github.com/ooples/token-optimizer-mcp/issues/298)) ([eb57606](https://github.com/ooples/token-optimizer-mcp/commit/eb57606a895c71ad5cc0946bbd5b23b4516a0490))
* **dev:** run server from local dist; add smoke tests; ignore logs ([72f5a5b](https://github.com/ooples/token-optimizer-mcp/commit/72f5a5b28b434edf197a69b8fd98caf6db66bd92))
* **dev:** run server from local dist; add smoke tests; ignore logs; temporarily disable file-ops in live config ([1961cc4](https://github.com/ooples/token-optimizer-mcp/commit/1961cc4ac0e184ada72daff7c4cd2b0118781f8c))
* **disclose:** never withhold content while reporting nothing omitted ([#288](https://github.com/ooples/token-optimizer-mcp/issues/288)) ([dc65b9c](https://github.com/ooples/token-optimizer-mcp/commit/dc65b9cf85bf551068b6203e1d133003d7c622ee))
* **doctor:** give each run a fresh session, so it stops failing its own second run ([#213](https://github.com/ooples/token-optimizer-mcp/issues/213)) ([8761b1f](https://github.com/ooples/token-optimizer-mcp/commit/8761b1f22ee21d75aa86deedea4cebf8a98493cb))
* **doctor:** report whether finding extraction is actually running ([#247](https://github.com/ooples/token-optimizer-mcp/issues/247)) ([7367250](https://github.com/ooples/token-optimizer-mcp/commit/7367250ecbea9a293a576b7edbe5214b7424b322))
* **doctor:** stop reporting a broken install as healthy ([#287](https://github.com/ooples/token-optimizer-mcp/issues/287)) ([04d17b5](https://github.com/ooples/token-optimizer-mcp/commit/04d17b524e793af79fa7f4b9651d0eb41988654a))
* **edit:** report the real line count, not the split artefact ([#274](https://github.com/ooples/token-optimizer-mcp/issues/274)) ([564e5c6](https://github.com/ooples/token-optimizer-mcp/commit/564e5c6a1b8ebb9f6dd8ce41e4fcd22c39370cfd))
* eliminate 3-6x slowdown with IPC daemon (resolves [#116](https://github.com/ooples/token-optimizer-mcp/issues/116)) ([#117](https://github.com/ooples/token-optimizer-mcp/issues/117)) ([0b9b1d3](https://github.com/ooples/token-optimizer-mcp/commit/0b9b1d3fb6c06fa7b94b772490ac432bfb7369d9))
* Enable actual token savings via PreToolUse cache retrieval ([b9d7e7c](https://github.com/ooples/token-optimizer-mcp/commit/b9d7e7cb7b8fbf1f6791b08df0e86093a8513fe3))
* Enable actual token savings via PreToolUse cache retrieval ([bf31225](https://github.com/ooples/token-optimizer-mcp/commit/bf31225caf5ac5dad6980ab4d3a41dbe34d9ae32))
* enable smart_read caching for 85-95% token reduction ([2eaa105](https://github.com/ooples/token-optimizer-mcp/commit/2eaa105f83639e0131f8d2a2bcaf4d60cde90b97))
* Enhance CSV parser WARNING with comprehensive note about limitations ([9122d3f](https://github.com/ooples/token-optimizer-mcp/commit/9122d3f3647ff4702b34fe8034c74a4d7e38ea83))
* enhance Get-CacheHitRate function documentation (iteration 1) ([d5bb272](https://github.com/ooples/token-optimizer-mcp/commit/d5bb2720544809f315ffe4ac71fb0c44d6e41345))
* ES module imports for Node.js compatibility ([#75](https://github.com/ooples/token-optimizer-mcp/issues/75)) ([7f0ef51](https://github.com/ooples/token-optimizer-mcp/commit/7f0ef51a75c321e1e8dc1b4dbd7dd7ef673f8500))
* **expand:** serve only what the pointer actually points at ([#289](https://github.com/ooples/token-optimizer-mcp/issues/289)) ([a4be61e](https://github.com/ooples/token-optimizer-mcp/commit/a4be61e9a0ec7175335093666c50be1e2716271d))
* Fix PowerShell compatibility issues in smart_read implementation ([9d2208a](https://github.com/ooples/token-optimizer-mcp/commit/9d2208a3a7d36e0c5f108187830a50996e93a90c))
* **fleet:** scope the scan, weight the comparison, read nothing before consent ([#290](https://github.com/ooples/token-optimizer-mcp/issues/290)) ([4473a07](https://github.com/ooples/token-optimizer-mcp/commit/4473a07b93b36b087fd707355d9f6963d2da1925))
* **forecast:** divide each arm by its own event count, not by the other's ([#297](https://github.com/ooples/token-optimizer-mcp/issues/297)) ([5491652](https://github.com/ooples/token-optimizer-mcp/commit/54916523a3c37fa57f156690beeed2fc8ee59385))
* **forecast:** let the panel publish a result that is bad for the product ([#291](https://github.com/ooples/token-optimizer-mcp/issues/291)) ([9efbe84](https://github.com/ooples/token-optimizer-mcp/commit/9efbe849f0625a1c8ec418caaffca2e5d99f6a49))
* **graph:** key unrooted files on a stable graph, not the caller cwd ([#279](https://github.com/ooples/token-optimizer-mcp/issues/279)) ([87f50d7](https://github.com/ooples/token-optimizer-mcp/commit/87f50d738e7358f87d5ae69c069e09ce5329ba31))
* **graph:** wire the memory half — harvest had no call site anywhere ([#215](https://github.com/ooples/token-optimizer-mcp/issues/215)) ([efa10ab](https://github.com/ooples/token-optimizer-mcp/commit/efa10ab9284cb8bcbc491907d61870d6109ce313))
* **harness:** make the a/b measurement instrument repeatable ([#246](https://github.com/ooples/token-optimizer-mcp/issues/246)) ([219d62a](https://github.com/ooples/token-optimizer-mcp/commit/219d62ad49f7b81c8993791c70486c5d5385795a))
* **harvest:** run the semantic harvest on the shared stop path ([#326](https://github.com/ooples/token-optimizer-mcp/issues/326)) ([0b39e7d](https://github.com/ooples/token-optimizer-mcp/commit/0b39e7d2cfa21f3b618a30586bd6eb6b1321cf0d))
* **hooks,tools:** close gap-analysis findings on top of [#175](https://github.com/ooples/token-optimizer-mcp/issues/175) ([#176](https://github.com/ooples/token-optimizer-mcp/issues/176)) ([99252ae](https://github.com/ooples/token-optimizer-mcp/commit/99252aec279a1767878136fe59712f006018de26))
* **hooks:** a path must not be able to abort the hook process ([#265](https://github.com/ooples/token-optimizer-mcp/issues/265)) ([44c673b](https://github.com/ooples/token-optimizer-mcp/commit/44c673b1afee5ea0bff9cf5e31485d900a44f37e))
* **hooks:** a write is not a read, and compaction ends the claim ([#257](https://github.com/ooples/token-optimizer-mcp/issues/257)) ([84525c2](https://github.com/ooples/token-optimizer-mcp/commit/84525c206ab60ac3351b7ab7850c2d956e75fbbd))
* **hooks:** look up command findings in the project the command runs in ([#271](https://github.com/ooples/token-optimizer-mcp/issues/271)) ([b19f1c5](https://github.com/ooples/token-optimizer-mcp/commit/b19f1c5d5b9a0aeab1185a87221e066756ac1324))
* **hooks:** remove mandatory param block consuming stdin when dot-sourced ([#88](https://github.com/ooples/token-optimizer-mcp/issues/88)) ([b3d8882](https://github.com/ooples/token-optimizer-mcp/commit/b3d8882d9e8e24f020f03d18177146980a0de9b3))
* **hooks:** say what was observed about an unreadable anchor ([#266](https://github.com/ooples/token-optimizer-mcp/issues/266)) ([8c00f5b](https://github.com/ooples/token-optimizer-mcp/commit/8c00f5b4021bcfa9e85adda03a3b4e6dc1279eb6))
* **hooks:** scope read state per agent, not per session ([#269](https://github.com/ooples/token-optimizer-mcp/issues/269)) ([19d326a](https://github.com/ooples/token-optimizer-mcp/commit/19d326a2e36b00aa0f33c2da61ddc887a436d260))
* **hooks:** serve findings before re-indexing, so an external change shows stale ([#275](https://github.com/ooples/token-optimizer-mcp/issues/275)) ([34c82f0](https://github.com/ooples/token-optimizer-mcp/commit/34c82f02088f07743fc204880b2bc6af3f9668e6))
* implement full functionality for 8 stub files flagged by Copilot ([79f5d7f](https://github.com/ooples/token-optimizer-mcp/commit/79f5d7ff60ed17dd9aaf8d0b5609bf4ee96f35ad))
* implement remaining 6 stub files from Copilot review (10,704 lines) ([83880f7](https://github.com/ooples/token-optimizer-mcp/commit/83880f78b55ba14107bbcff0cc6803df665f5cbe))
* improve default value semantics per Copilot review ([c2a34b0](https://github.com/ooples/token-optimizer-mcp/commit/c2a34b0d758c0461aa2af71864b8af19e8184b1b))
* **inject:** match the framing to the evidence, not to the strongest wording available ([#270](https://github.com/ooples/token-optimizer-mcp/issues/270)) ([c29896f](https://github.com/ooples/token-optimizer-mcp/commit/c29896f18b5484c2047103d59063f40d0a17e03d))
* install verification, plugin-aware doctor, and release pin drift ([#241](https://github.com/ooples/token-optimizer-mcp/issues/241)) ([0295a23](https://github.com/ooples/token-optimizer-mcp/commit/0295a23d0b46919c80b53524eaa0f0de335692dc))
* **install:** make wiring recoverable when npm blocks postinstall ([#214](https://github.com/ooples/token-optimizer-mcp/issues/214)) ([f6e146c](https://github.com/ooples/token-optimizer-mcp/commit/f6e146c0dfd510b3425efc1880a16abc94f405d2))
* **keepwarm,lessons:** make the tripwire reachable, the gaps per-session, the anchors real ([#295](https://github.com/ooples/token-optimizer-mcp/issues/295)) ([c22bc55](https://github.com/ooples/token-optimizer-mcp/commit/c22bc55600014c59c61e6a225034f5c6a2f20b93))
* **keepwarm,lessons:** score refreshes with the model that bought them ([#293](https://github.com/ooples/token-optimizer-mcp/issues/293)) ([ff158bf](https://github.com/ooples/token-optimizer-mcp/commit/ff158bf3d4021c5b13398392e1b28d824bebf8fc))
* mcp server exits before registering tools on windows ([#307](https://github.com/ooples/token-optimizer-mcp/issues/307)) ([#308](https://github.com/ooples/token-optimizer-mcp/issues/308)) ([81f5d55](https://github.com/ooples/token-optimizer-mcp/commit/81f5d55953a2556bd3f872460d97ca0e40e7844e))
* **mcp:** close the two verification holes that let bad schemas and stale manifests through ([#262](https://github.com/ooples/token-optimizer-mcp/issues/262)) ([a6fa649](https://github.com/ooples/token-optimizer-mcp/commit/a6fa6498e8f7342be84849332a3b358052aed140))
* **mcp:** declare the options tools accept, and ratchet the rest ([#258](https://github.com/ooples/token-optimizer-mcp/issues/258)) ([30dc75d](https://github.com/ooples/token-optimizer-mcp/commit/30dc75d82c74c6cbb3c99746b0ff1335703ea70f))
* **mcp:** finish declaring every option every tool accepts ([#261](https://github.com/ooples/token-optimizer-mcp/issues/261)) ([03828e9](https://github.com/ooples/token-optimizer-mcp/commit/03828e9516a23f8052e4fc9a1cf8b4a0abbee3c1))
* **metrics:** the causal measurement had never produced a single reading ([#251](https://github.com/ooples/token-optimizer-mcp/issues/251)) ([516a032](https://github.com/ooples/token-optimizer-mcp/commit/516a032b418c87bc8ee13a5bd6fdd5c0c1b846cd))
* move background optimization and session fixes to PR (wrongly committed to master) ([#128](https://github.com/ooples/token-optimizer-mcp/issues/128)) ([1ac3e7b](https://github.com/ooples/token-optimizer-mcp/commit/1ac3e7bdd7f62cceb384dd999db3a082337f4501))
* **paths:** canonicalise to a fixed point by construction, not by patching ([#243](https://github.com/ooples/token-optimizer-mcp/issues/243)) ([1ce8308](https://github.com/ooples/token-optimizer-mcp/commit/1ce8308fd31625ce18d7b6b223b0bac1b651307a))
* **pending:** adopt a claim stranded by a killed drainer ([#325](https://github.com/ooples/token-optimizer-mcp/issues/325)) ([877f66b](https://github.com/ooples/token-optimizer-mcp/commit/877f66b2ca71441d64798586eb061b19ef159bc5))
* **pkg:** ship the enforcement hooks and installer scripts ([#211](https://github.com/ooples/token-optimizer-mcp/issues/211)) ([d05babd](https://github.com/ooples/token-optimizer-mcp/commit/d05babd0e86ae900f3965ccfad769a5c0dba1106))
* **plugins:** track plugin .mcp.json + add native Codex plugin packaging ([#191](https://github.com/ooples/token-optimizer-mcp/issues/191)) ([9a58141](https://github.com/ooples/token-optimizer-mcp/commit/9a581416cb728df3fc0e17162c69e296decf00a0))
* **PR-30:** Address GitHub Copilot review comments ([11b2691](https://github.com/ooples/token-optimizer-mcp/commit/11b2691e89e2170532f6f3a38d62e9361e4b17e1))
* prevent BOM in JSON files written by install-hooks.ps1 ([#105](https://github.com/ooples/token-optimizer-mcp/issues/105)) ([291e58a](https://github.com/ooples/token-optimizer-mcp/commit/291e58a8bb5ed882e885178ddb1a43c9552c14e1))
* reformat 3 system-operations tools with proper imports ([#81](https://github.com/ooples/token-optimizer-mcp/issues/81)) ([df1c690](https://github.com/ooples/token-optimizer-mcp/commit/df1c6901d19c246f7060edf7b140b7f82c764c6e))
* register smart_read and 4 other critical file operation tools ([9898e82](https://github.com/ooples/token-optimizer-mcp/commit/9898e825b9815ae019c3f969bba0a9fa1daeb05b))
* Register smart_read and 4 other critical file operation tools ([0ea9871](https://github.com/ooples/token-optimizer-mcp/commit/0ea9871832103962e3ebca4c3f186c27e738f4f1))
* **release:** drop the redundant full test rerun from npm publish ([#186](https://github.com/ooples/token-optimizer-mcp/issues/186)) ([6874f62](https://github.com/ooples/token-optimizer-mcp/commit/6874f62fb58c0ccb44518b1fa4eb8df700276567))
* **release:** enable automated npm publishing and fix draft releases ([#63](https://github.com/ooples/token-optimizer-mcp/issues/63)) ([0f7acb1](https://github.com/ooples/token-optimizer-mcp/commit/0f7acb13ca7f1dfa1c568a4c32caaba6b99f0339))
* **release:** recognize existing vX.Y.Z tags in release-please ([#183](https://github.com/ooples/token-optimizer-mcp/issues/183)) ([4637590](https://github.com/ooples/token-optimizer-mcp/commit/46375901ca6b357c01f28e254f2d43219d7b82ef))
* **release:** repair the pins during the release instead of failing on them ([#253](https://github.com/ooples/token-optimizer-mcp/issues/253)) ([5c005f3](https://github.com/ooples/token-optimizer-mcp/commit/5c005f319c5facb4ce4605104c155a1a8bb0abdc))
* **release:** resolve the mcp spec at launch instead of pinning it in git ([#256](https://github.com/ooples/token-optimizer-mcp/issues/256)) ([9672b39](https://github.com/ooples/token-optimizer-mcp/commit/9672b39e4cfe6b8818b342b85b95d8e6d0511e31))
* **release:** sync pinned specs from an event that actually fires ([#254](https://github.com/ooples/token-optimizer-mcp/issues/254)) ([e7ff984](https://github.com/ooples/token-optimizer-mcp/commit/e7ff984ef88adc1be6cccb5ce28e77114063de00))
* **release:** unblock the 5.4.0 publish, and stop the harvest worker crashing on exit ([#245](https://github.com/ooples/token-optimizer-mcp/issues/245)) ([1ecd165](https://github.com/ooples/token-optimizer-mcp/commit/1ecd165227cfa6a242ef3fa71f4eeafc710f37ba))
* **release:** verify the released tag instead of repairing it first ([#260](https://github.com/ooples/token-optimizer-mcp/issues/260)) ([da596ca](https://github.com/ooples/token-optimizer-mcp/commit/da596ca70cae51f4dcffa0e0e8a5339087a207c3))
* remove conflicting Start-Process parameters causing silent failures ([6e43e7c](https://github.com/ooples/token-optimizer-mcp/commit/6e43e7c1b1bdcafca902e26909208403543a7db2))
* remove individual asset uploads from github releases to prevent duplicate errors ([e44626d](https://github.com/ooples/token-optimizer-mcp/commit/e44626d15660c79801003f13bf149c5398d4fd37))
* remove inefficient Buffer conversions in smart-process.ts ([aa27b4c](https://github.com/ooples/token-optimizer-mcp/commit/aa27b4ca4a5ebb037b70e05448cd65fbb059f5a2))
* remove inefficient Buffer conversions per Copilot review ([7f29129](https://github.com/ooples/token-optimizer-mcp/commit/7f291294b0d97b6b41acc5d36238abaa5514e2ea))
* Remove non-production-ready periodic optimization trigger ([9a09b4e](https://github.com/ooples/token-optimizer-mcp/commit/9a09b4e50f2583c39df279e1ea085f53c2c6c972))
* remove pscustomobject casts causing argument serialization bug ([#107](https://github.com/ooples/token-optimizer-mcp/issues/107)) ([d38efe0](https://github.com/ooples/token-optimizer-mcp/commit/d38efe03d0b63fbf4286db5979de9072f67cf625))
* remove unused imports from smart-refactor.ts per Copilot review ([4836ea4](https://github.com/ooples/token-optimizer-mcp/commit/4836ea4b9187e510d5b55bd3d779a4a3e2abafc8))
* remove unused preservefirst variable ([#98](https://github.com/ooples/token-optimizer-mcp/issues/98)) ([fd6b932](https://github.com/ooples/token-optimizer-mcp/commit/fd6b932069d1abed56cae8206b45fc6bfb7bf115))
* remove unused smartastgrepoptions import ([#74](https://github.com/ooples/token-optimizer-mcp/issues/74)) ([b2cdeba](https://github.com/ooples/token-optimizer-mcp/commit/b2cdeba9da54a5cc058f26bbb0fc841f4f9f1749))
* remove unused SmartAstGrepOptions type import ([#73](https://github.com/ooples/token-optimizer-mcp/issues/73)) ([cb963cf](https://github.com/ooples/token-optimizer-mcp/commit/cb963cf72997d8499f2068008adc0aa3c470af38))
* Remove unused type imports in smart-metrics.ts ([16b6dd0](https://github.com/ooples/token-optimizer-mcp/commit/16b6dd087cafe1f86f285273a5218cc12bcc7dbe))
* rename postinstall script to cjs for commonjs compatibility ([5cc3345](https://github.com/ooples/token-optimizer-mcp/commit/5cc33456de4632dc1f6dd30ab20735963f197c8c))
* repair broken PowerShell hooks and 5 MCP tool bugs (15 user-reported issues) ([#175](https://github.com/ooples/token-optimizer-mcp/issues/175)) ([ced86aa](https://github.com/ooples/token-optimizer-mcp/commit/ced86aa345771e33e71d9db7ff5a899ef88acf28))
* Replace manual cache management with smart_read MCP tool ([fcd577b](https://github.com/ooples/token-optimizer-mcp/commit/fcd577b939adc6d6ecf29506218e8c11b11dc078))
* Replace manual cache management with smart_read MCP tool ([7498ec8](https://github.com/ooples/token-optimizer-mcp/commit/7498ec817f26e1090728ac9099ac6392a30baacc))
* Resolve 11 TypeScript build errors ([94d613e](https://github.com/ooples/token-optimizer-mcp/commit/94d613e0af4337e0713912847e443f0e8dd4286d))
* Resolve 11 TypeScript build errors ([83387a7](https://github.com/ooples/token-optimizer-mcp/commit/83387a7a167fd5e2cbfef30fd977071331a113a9))
* resolve 18 property conflicts and shape mismatches (US-BF-004) ([e3288e7](https://github.com/ooples/token-optimizer-mcp/commit/e3288e775b5e9e8992bcef98d213c38a3b817e1d))
* resolve 7 critical cache bugs and pipeline failure ([8820f23](https://github.com/ooples/token-optimizer-mcp/commit/8820f23bbcc62871759c973c9b30267187d7038d))
* Resolve 7 critical cache bugs and release pipeline failure ([f5ba7b1](https://github.com/ooples/token-optimizer-mcp/commit/f5ba7b1bf60a1d04691f560ad56a525cbf7e2168))
* resolve critical negative token savings and 0% cache hit rate (all phases) ([#118](https://github.com/ooples/token-optimizer-mcp/issues/118)) ([8138f3a](https://github.com/ooples/token-optimizer-mcp/commit/8138f3a6d32eff80387f24d6068039ae8fb7bfa9))
* resolve critical token tracking and versioning issues (v3.1.1) ([#110](https://github.com/ooples/token-optimizer-mcp/issues/110)) ([1a3da5e](https://github.com/ooples/token-optimizer-mcp/commit/1a3da5e46bfe6621a7a9a7fcd7bc049491aa5719))
* resolve critical token tracking bug caused by PowerShell $args collision ([#111](https://github.com/ooples/token-optimizer-mcp/issues/111)) ([4d5a0c5](https://github.com/ooples/token-optimizer-mcp/commit/4d5a0c50e8ec0b3ce87ddbc62bf541638e19e520))
* resolve merge conflict and improve strength handling ([edafd5c](https://github.com/ooples/token-optimizer-mcp/commit/edafd5c385a5263634aa2534cb299cd1c160be5e))
* resolve merge conflict in server/index.ts ([81504de](https://github.com/ooples/token-optimizer-mcp/commit/81504de66daa6598cb334dc0cd659422ddbd2f38))
* resolve merge conflicts and fix getEntryMetadata calls ([ed4391a](https://github.com/ooples/token-optimizer-mcp/commit/ed4391acdecab197f2b0297192a579f12f7d20ce))
* resolve merge conflicts with master (PR [#8](https://github.com/ooples/token-optimizer-mcp/issues/8) null safety fixes) ([d90a3ff](https://github.com/ooples/token-optimizer-mcp/commit/d90a3ff09616a0d6de6b42fa2dc320c8b27e8567))
* resolve powershell parse errors and session file corruption ([ceaf8e1](https://github.com/ooples/token-optimizer-mcp/commit/ceaf8e10d9df76022074a8c331cbb3ed25163f03))
* resolve TypeScript compilation errors (138 errors fixed) ([18168ce](https://github.com/ooples/token-optimizer-mcp/commit/18168ce60c9f3f590576d9b7dc1a92815a6e6719))
* Sanitize CSS class names and document lookup_cache non-issue ([8124514](https://github.com/ooples/token-optimizer-mcp/commit/81245144b756010f98b26ba2de19489b03a79cb0))
* **scripts:** document/avoid silent JSON parse failures; extract percentage precision constant for clarity ([d6956e9](https://github.com/ooples/token-optimizer-mcp/commit/d6956e932525d7669fa1af1ea06ec40bba559279))
* **scripts:** guard division by zero in live-test and use consistent newline write in smoke script ([29da04e](https://github.com/ooples/token-optimizer-mcp/commit/29da04ed2843f80366b7d35d96e708e2add0a3f0))
* **search:** honour `path` and survive oversized result sets ([#249](https://github.com/ooples/token-optimizer-mcp/issues/249)) ([bf3870f](https://github.com/ooples/token-optimizer-mcp/commit/bf3870fcec33e7bf004c734f91b7790f266c3585))
* **search:** let path name a single file instead of answering zero ([#263](https://github.com/ooples/token-optimizer-mcp/issues/263)) ([359f556](https://github.com/ooples/token-optimizer-mcp/commit/359f556c74d7dc22ccb011d45c787bee099b8041))
* **search:** make count mode actually return counts ([#273](https://github.com/ooples/token-optimizer-mcp/issues/273)) ([710747d](https://github.com/ooples/token-optimizer-mcp/commit/710747d78480c4c6275112b8709c98cb8c6061ca))
* **search:** say when a literal zero was hiding a regex match ([#276](https://github.com/ooples/token-optimizer-mcp/issues/276)) ([c11a20e](https://github.com/ooples/token-optimizer-mcp/commit/c11a20ee2cdc713b1f28918a0e642260a3176860))
* **search:** stop hiding every dot-directory, including .github ([#268](https://github.com/ooples/token-optimizer-mcp/issues/268)) ([4f59b98](https://github.com/ooples/token-optimizer-mcp/commit/4f59b98d0cf665b87a9fc0e66f444eb0e514d438))
* **security:** eliminate os command injection across smart_* tools ([#169](https://github.com/ooples/token-optimizer-mcp/issues/169)) ([b4ee96d](https://github.com/ooples/token-optimizer-mcp/commit/b4ee96dac799cbfba0a9f9c17844ce9d613cbcc7))
* **security:** scanner reported no findings over live-format api keys ([#223](https://github.com/ooples/token-optimizer-mcp/issues/223)) ([beb2ebd](https://github.com/ooples/token-optimizer-mcp/commit/beb2ebdd9065ff68f7b31492875025c39a48b97d))
* **server:** exit stdio server on stdin close to prevent Windows orphan-leak ([#177](https://github.com/ooples/token-optimizer-mcp/issues/177)) ([0408bee](https://github.com/ooples/token-optimizer-mcp/commit/0408bee1a476814be830d12adec05a4165eeff95))
* **server:** mistyped tool arguments were dropped instead of refused ([#228](https://github.com/ooples/token-optimizer-mcp/issues/228)) ([800d4e0](https://github.com/ooples/token-optimizer-mcp/commit/800d4e00fbdcf36a4c75aa7e0422bc9315819798))
* smart_ast_grep was entirely non-functional on windows, and said nothing ([#226](https://github.com/ooples/token-optimizer-mcp/issues/226)) ([56873b9](https://github.com/ooples/token-optimizer-mcp/commit/56873b93d7d04c11d8167b66f55d07dc3aa7f387))
* smart_env returned every .env value; smart_dependencies never delivered its graph ([#225](https://github.com/ooples/token-optimizer-mcp/issues/225)) ([a963995](https://github.com/ooples/token-optimizer-mcp/commit/a963995b91d2865b4f9c982d29877f8f7d5d2ce8))
* **smart_read:** guard zod-v4 error issues and require non-empty path ([#167](https://github.com/ooples/token-optimizer-mcp/issues/167)) ([4ae7c35](https://github.com/ooples/token-optimizer-mcp/commit/4ae7c351659b3a1a7f741f6dc427577aead9fdd8))
* **smart-edit:** a silently dropped edit reported success ([#231](https://github.com/ooples/token-optimizer-mcp/issues/231)) ([31c5394](https://github.com/ooples/token-optimizer-mcp/commit/31c53946d59cce5e4e8f959a487d921cd62e5001))
* stabilize performance tests and remove security vulnerabilities ([4216a7d](https://github.com/ooples/token-optimizer-mcp/commit/4216a7d4f5ce53172aaeb741f764e9a621a0fcef))
* stamp the shipped version at publish time so releases can reach npm ([#330](https://github.com/ooples/token-optimizer-mcp/issues/330)) ([10eaad4](https://github.com/ooples/token-optimizer-mcp/commit/10eaad4d730aef3b40e39fbee91b48f4fbd54d61))
* **tests:** resolve performance benchmark failures ([d647fa0](https://github.com/ooples/token-optimizer-mcp/commit/d647fa07c8611b02d630784350fba0ede6375c4e))
* **tokens:** counting silently fell back to length/4, overstating savings by up to 130% ([#222](https://github.com/ooples/token-optimizer-mcp/issues/222)) ([97a9027](https://github.com/ooples/token-optimizer-mcp/commit/97a90276f41670a857103b859d63566d820c0317))
* **tools:** refactor cache operations to use centralized cache-helper utility ([f885858](https://github.com/ooples/token-optimizer-mcp/commit/f885858f8c9738571b135220b4124388b87090f4))
* update tests for new token counter api signature ([c32d1ac](https://github.com/ooples/token-optimizer-mcp/commit/c32d1ac9d2ecd107298c49b2ca4ef2a3033586d0))
* **US-AC-001:** Address all GitHub Copilot review comments ([021ac86](https://github.com/ooples/token-optimizer-mcp/commit/021ac8640420b9edf348008ec0c682fe10537f4e))
* **US-AC-001:** Address GitHub Copilot review comments ([aa7e01f](https://github.com/ooples/token-optimizer-mcp/commit/aa7e01f458f6953a877b6e6cf8a37d23ab3078fb))
* **US-BF-001:** Remove 60 unused variables (TS6133) ([00c129e](https://github.com/ooples/token-optimizer-mcp/commit/00c129e1c0ce975d22ad90a8e2e155a3da6a2554))
* **US-BF-001:** Remove 60 unused variables (TS6133) ([642d5e3](https://github.com/ooples/token-optimizer-mcp/commit/642d5e3f21a894c770fc012836a0d6012dcb461f))
* **US-BF-001:** Remove unused variables ([4131933](https://github.com/ooples/token-optimizer-mcp/commit/4131933476d8654c9072e862932cdae5ee514463))
* **US-BF-001:** Remove unused variables to resolve TS6133 errors ([0b6a389](https://github.com/ooples/token-optimizer-mcp/commit/0b6a389487b73c6d5b2e21bdece70aa6c6357caa))
* **US-BF-002:** Address GitHub Copilot review comments ([25a3c34](https://github.com/ooples/token-optimizer-mcp/commit/25a3c340cd77376479cbc395acd29304a798cfaf))
* **US-BF-002:** Fix TypeScript type errors in tools ([6a35736](https://github.com/ooples/token-optimizer-mcp/commit/6a35736925e202d9c1dd429613d9c316579ac6c6))
* **US-BF-002:** Fix TypeScript type errors in tools ([9a60697](https://github.com/ooples/token-optimizer-mcp/commit/9a6069776394c88672183f0e7c5b730b24edcecc))
* **US-BF-005:** Fix ModelMetrics type incompatibility ([59d5482](https://github.com/ooples/token-optimizer-mcp/commit/59d548242e5e6713ebe4f936f460fc3e399068c5))
* **US-BF-005:** Fix ModelMetrics type incompatibility in predictive-cache.ts ([680d174](https://github.com/ooples/token-optimizer-mcp/commit/680d17426f0101404be2879d97574d3734130ffe))
* **US-BF-006:** Remove read-only property assignment in smart-cache.ts ([4ea9b5c](https://github.com/ooples/token-optimizer-mcp/commit/4ea9b5c30a126be8deb50764a301b7611d3ea837))
* **US-BF-006:** Remove read-only property assignment in smart-cache.ts ([6bdb06f](https://github.com/ooples/token-optimizer-mcp/commit/6bdb06fb43749c03d306014e7a97c2877503c0da))
* **US-BF-007:** Add required operation property to SmartCacheOptions ([2a3fe09](https://github.com/ooples/token-optimizer-mcp/commit/2a3fe09863f1556b53bd5cb904639eea37e99204))
* **US-BF-007:** Add required operation property to SmartCacheOptions ([c76c50d](https://github.com/ooples/token-optimizer-mcp/commit/c76c50d0b0889a4940ff179672555fdce20280af))
* **US-BF-008:** Fix argument count mismatch in smart-api-fetch.ts ([a73d91d](https://github.com/ooples/token-optimizer-mcp/commit/a73d91d059c32c3d37a850f762cd81425b185533))
* **US-BF-008:** Fix argument count mismatch in smart-api-fetch.ts ([202897e](https://github.com/ooples/token-optimizer-mcp/commit/202897eb0ddcefeff1fd68b320050b4f3880e36d))
* **US-BF-009:** Add Buffer type conversions in multiple files ([883917a](https://github.com/ooples/token-optimizer-mcp/commit/883917a12e76ecfc2d5a43ad1f5a3b362dece2d8))
* **US-BF-009:** Add Buffer type conversions in multiple files ([95ae65b](https://github.com/ooples/token-optimizer-mcp/commit/95ae65bc0a6971d964645b3bb70c674a6cae2634))
* **US-BF-010:** Resolve CacheEngine constructor parameter order issues ([5fe1380](https://github.com/ooples/token-optimizer-mcp/commit/5fe1380e53eee6d08ec47980fd7b32a08eb077b6))
* **US-BF-020:** Correct encoding type arguments and cache.set() parameters ([9cb737a](https://github.com/ooples/token-optimizer-mcp/commit/9cb737ac673f32119dcd362e641f3f7223f20831))
* **US-BF-023:** Correct type mismatch string to object ([1e381ad](https://github.com/ooples/token-optimizer-mcp/commit/1e381adca9242b1ec96cd91a1e70e7c110e0a98b))
* **US-BF-023:** Correct type mismatch string to Record&lt;string, unknown&gt; ([5327596](https://github.com/ooples/token-optimizer-mcp/commit/532759635b525d900453a3dc14e7b122490285d2))
* **US-BF-023:** Fix type mismatches (string to object) in dashboard files ([57e7dbc](https://github.com/ooples/token-optimizer-mcp/commit/57e7dbc601fe936533e3b824830727c2cfb25c3f))
* **US-BF-023:** Use structured objects for generateCacheKey ([d955613](https://github.com/ooples/token-optimizer-mcp/commit/d955613425f9b979c810e1ea6d4d41cc6b068a8a))
* **US-BF-024:** Harmonize filters declarations in log-dashboard.ts ([e5c414d](https://github.com/ooples/token-optimizer-mcp/commit/e5c414dcf89d08d8197b853fed7cdd357a87fd17))
* **US-BF-024:** Harmonize filters declarations in log-dashboard.ts ([c3975e0](https://github.com/ooples/token-optimizer-mcp/commit/c3975e0e3598ac613cc26d95812fa52ccc52c905))
* **US-BF-026:** Complete LogDashboard object creation in log-dashboar… ([5d51865](https://github.com/ooples/token-optimizer-mcp/commit/5d51865816bc06267f6aeb1d29342ab0fce65d1e))
* **US-BF-026:** Complete LogDashboard object creation in log-dashboard.ts ([fc6970b](https://github.com/ooples/token-optimizer-mcp/commit/fc6970bdaa89f671f11e509abc1ce29e9f08c01a))
* **US-BF-033:** Handle undefined assignment in anomaly-explainer.ts ([b3dd2b7](https://github.com/ooples/token-optimizer-mcp/commit/b3dd2b72c69ac3cd700d280c2288fdee147eb05f))
* **US-BF-033:** Handle undefined assignment to number in anomaly-explainer.ts ([55671ad](https://github.com/ooples/token-optimizer-mcp/commit/55671ad43b7707e2c62041da78a2196dc432af5e))
* **US-BF-033:** Handle undefined assignment to number in anomaly-explainer.ts ([8f5961c](https://github.com/ooples/token-optimizer-mcp/commit/8f5961c05d25a441af91543361bf020bbe5f389e))
* **US-BF-033:** Handle undefined assignment to number in anomaly-explainer.ts ([9b11a34](https://github.com/ooples/token-optimizer-mcp/commit/9b11a341c73227b45ad8c034043679546d13e0c2))
* **US-BF-033:** Use conditional spread for optional strength field ([c6b8751](https://github.com/ooples/token-optimizer-mcp/commit/c6b8751cfa67567452d6022211ee6c75550e3648))
* **US-BF-034:** Import createHash from crypto in knowledge-graph.ts ([e7237be](https://github.com/ooples/token-optimizer-mcp/commit/e7237bece439d6bd1597819047619c9d5bc16dbb))
* **US-BF-034:** Import createHash from crypto in knowledge-graph.ts ([170c35f](https://github.com/ooples/token-optimizer-mcp/commit/170c35f16fd328071bd206980204674001d93903))
* **US-BF-035:** Correct TokenCountResult usage in sentiment-analysis.ts ([061942f](https://github.com/ooples/token-optimizer-mcp/commit/061942f8a2c3f0139495e90cce412d7b575318c6))
* **US-BF-035:** Correct TokenCountResult usage in sentiment-analysis.ts ([b4b3e38](https://github.com/ooples/token-optimizer-mcp/commit/b4b3e3877d090a15b5e3d7b13f2c88672a575333))
* **US-BF-039:** Convert Buffer to string in smart-process.ts ([c2a8cd5](https://github.com/ooples/token-optimizer-mcp/commit/c2a8cd55af43ee224891403d369bfebd169e7e06))
* **US-BF-039:** Convert Buffer to string in smart-process.ts ([0d93d6e](https://github.com/ooples/token-optimizer-mcp/commit/0d93d6e4c259d7bcbc4d9bf996d3d5b5908c263f))
* **US-CF-005:** Address all Copilot feedback - security and performance improvements ([f89976b](https://github.com/ooples/token-optimizer-mcp/commit/f89976ba55088d540641ec84080e8e5a28eca9a7))
* **US-CI-001:** Address all 6 GitHub Copilot review comments ([ae2f15f](https://github.com/ooples/token-optimizer-mcp/commit/ae2f15f81e72f589ae131660849e606daf3eb43a))
* **US-CI-001:** Address GitHub Copilot review comments on PR [#31](https://github.com/ooples/token-optimizer-mcp/issues/31) ([d716eda](https://github.com/ooples/token-optimizer-mcp/commit/d716eda1bd9a015e065cea22782314ad5771908c))
* **US-CI-001:** Fix TypeScript import consistency ([980289e](https://github.com/ooples/token-optimizer-mcp/commit/980289eaebe91465484e49306ba8add09b5deb8f))
* **US-CI-001:** Update remaining getEntryMetadata call sites ([c102699](https://github.com/ooples/token-optimizer-mcp/commit/c102699f9f5e8fe1d35661bbbc5499b178ad431e))
* **US-CI-002:** Address 8 GitHub Copilot review comments ([9d6c18c](https://github.com/ooples/token-optimizer-mcp/commit/9d6c18cad1980754322d43df1712d834ad85bb6b))
* **US-CI-002:** Address all 4 GitHub Copilot review comments ([359ddbc](https://github.com/ooples/token-optimizer-mcp/commit/359ddbccfc76bb91d86ccfd43cc985929b2cdcc8))
* **US-CI-002:** Extract parseSessionLog utility to avoid code duplication ([1501dec](https://github.com/ooples/token-optimizer-mcp/commit/1501decdcbaa61424c3830c7d5e63b6caede1b10))
* **US-CI-002:** Resolve merge conflict with master ([040fcb2](https://github.com/ooples/token-optimizer-mcp/commit/040fcb235019f6d3160c964365817a312289fe99))
* **US-CI-003:** Use logical OR operator for environment variable access ([c43b5f2](https://github.com/ooples/token-optimizer-mcp/commit/c43b5f2c9c286d74183b4e56d70f0b74176be22c))
* **US-CI-005:** Fix build errors in supporting files ([fd262ba](https://github.com/ooples/token-optimizer-mcp/commit/fd262ba088fbb3445c8fd8f88cacd2963420b17a))
* **US-CI-008:** Add comprehensive documentation for token reduction percentages ([5964f63](https://github.com/ooples/token-optimizer-mcp/commit/5964f632b193655b28039f688decce2cb582aace))
* **US-CI-008:** Address 4 GitHub Copilot review comments ([90d7bef](https://github.com/ooples/token-optimizer-mcp/commit/90d7bef1abdd35ae5d62ceaf564a835f116a99d7))
* **US-CI-008:** Extract magic numbers as named constants ([731d9ba](https://github.com/ooples/token-optimizer-mcp/commit/731d9bacea7da09cf495e5f92e51c1ba8b9a2b8a))
* **US-EF-001:** Address Copilot feedback - use ES6 shorthand and Math.round pattern ([0f68752](https://github.com/ooples/token-optimizer-mcp/commit/0f687526518f74bc22413c86c313b5de4e146c72))
* **US-NF-001:** Add explicit comments clarifying review concerns (iteration 2) ([7252260](https://github.com/ooples/token-optimizer-mcp/commit/7252260375fd89c3316f92562906d28fe6454c55))
* **US-NF-001:** Address all 20 GitHub Copilot review comments on PR [#28](https://github.com/ooples/token-optimizer-mcp/issues/28) ([2151ff4](https://github.com/ooples/token-optimizer-mcp/commit/2151ff4a973340da22d23593e08e075248cf9e64))
* **US-NF-001:** Address all 6 GitHub Copilot review comments on PR [#28](https://github.com/ooples/token-optimizer-mcp/issues/28) ([e0afad1](https://github.com/ooples/token-optimizer-mcp/commit/e0afad1745c33d2939142b0d893572c45ad4e40e))
* **US-NF-001:** Address all 9 GitHub Copilot review comments on PR [#28](https://github.com/ooples/token-optimizer-mcp/issues/28) ([c336879](https://github.com/ooples/token-optimizer-mcp/commit/c336879dbfc34911ac0a3cac8a8cb30825473881))
* **US-NF-001:** Address final 2 Copilot review comments (iteration 3) ([5d3247b](https://github.com/ooples/token-optimizer-mcp/commit/5d3247b91abf55a2a5b5b604f206cece10ead7b4))
* **US-NF-001:** Address GitHub Copilot review comments ([38ad92b](https://github.com/ooples/token-optimizer-mcp/commit/38ad92bb0d6c3b9f0e3da23b787cd78834bdb5c3))
* **US-NF-001:** Address GitHub Copilot review comments (iteration 1) ([e9765eb](https://github.com/ooples/token-optimizer-mcp/commit/e9765ebd7f6413523b53b2c48cdc92c8b16955b3))
* **US-NF-001:** Address GitHub Copilot review comments (iteration 1) ([bfd6e5e](https://github.com/ooples/token-optimizer-mcp/commit/bfd6e5ebfb5a392985f22d9cc81ad9bc00b6e05d))
* **US-NF-001:** Address GitHub Copilot review comments (iteration 2) ([857f69f](https://github.com/ooples/token-optimizer-mcp/commit/857f69f30c19dd98df0c11068041fa5e9d4bed0a))
* **US-NF-001:** Address GitHub Copilot review comments on PR [#28](https://github.com/ooples/token-optimizer-mcp/issues/28) ([2b58733](https://github.com/ooples/token-optimizer-mcp/commit/2b5873323ad4c3b74c4a13326a1f74b3f37564ed))
* **US-NF-001:** Address GitHub Copilot review comments on PR [#28](https://github.com/ooples/token-optimizer-mcp/issues/28) ([0f9f2c0](https://github.com/ooples/token-optimizer-mcp/commit/0f9f2c09a0fb1a018c616d9340a4709208e17991))
* **US-NF-001:** Address GitHub Copilot review comments on PR [#28](https://github.com/ooples/token-optimizer-mcp/issues/28) ([2ca71f6](https://github.com/ooples/token-optimizer-mcp/commit/2ca71f65424b35c712071484c3ce297a270e1a22))
* **US-NF-001:** Address remaining Copilot review comments (iteration 4) ([bb26688](https://github.com/ooples/token-optimizer-mcp/commit/bb26688763aa969707804590a5ba3e9b645f3c61))
* **US-NF-001:** Enhance documentation for encoding and blocking I/O concerns ([13e1337](https://github.com/ooples/token-optimizer-mcp/commit/13e1337c2d4011a22ea8d502dc949c1923013425))
* **US-NF-002:** Address 2 additional Copilot review comments ([5ed2a60](https://github.com/ooples/token-optimizer-mcp/commit/5ed2a60dfb5ce5f870221a8e1a925b87a5549e7b))
* **US-NF-002:** Address ALL 5 GitHub Copilot review comments ([9054931](https://github.com/ooples/token-optimizer-mcp/commit/9054931289a992ce6b04425eea224a959b5a34a6))
* **US-NF-002:** Address GitHub Copilot review comments ([2343fba](https://github.com/ooples/token-optimizer-mcp/commit/2343fbae2ab3c28dc6febd755192e2787f2cabdd))
* **US-NF-002:** Address GitHub Copilot review comments ([1f782aa](https://github.com/ooples/token-optimizer-mcp/commit/1f782aac7f3cba9b0e31046e3efbe0d638078727))
* **US-NF-002:** Correct thinkingModePercent calculation - value is already a percentage ([f693cec](https://github.com/ooples/token-optimizer-mcp/commit/f693cec63ced7fd9fd8db846b8c4c20c484a8146))
* **US-NF-002:** Extract percentage calculation to helper function to eliminate code duplication ([9344f17](https://github.com/ooples/token-optimizer-mcp/commit/9344f17843936d388c3bcf9bc8a96605805ac5b4))
* **US-NF-002:** Fix division by zero and add score normalization ([c1b157d](https://github.com/ooples/token-optimizer-mcp/commit/c1b157de7938f7ed82b58823c4e8075b686754f7))
* **US-NF-002:** Implement missing statistical helper functions ([86febe5](https://github.com/ooples/token-optimizer-mcp/commit/86febe574bd149b8e321e441ab267129aef798cd))
* **US-NF-002:** Use calculatePercentage helper for thinkingModePercent consistency ([518c1e3](https://github.com/ooples/token-optimizer-mcp/commit/518c1e3853f32171112b7ea80558a766224dc068))
* **US-NF-003:** Address all 8 GitHub Copilot review comments on PR [#27](https://github.com/ooples/token-optimizer-mcp/issues/27) ([380fdb2](https://github.com/ooples/token-optimizer-mcp/commit/380fdb2d90565998b606efa56dc959058ae7608a))
* **US-NF-003:** Address GitHub Copilot review comments ([866946b](https://github.com/ooples/token-optimizer-mcp/commit/866946b0eed2005fc4b2bb0ebd9007ab2644fb03))
* **US-NF-003:** Address GitHub Copilot review comments on PR [#27](https://github.com/ooples/token-optimizer-mcp/issues/27) ([6783b68](https://github.com/ooples/token-optimizer-mcp/commit/6783b6876f9db7379f5cde8afc1a0d553b2987a1))
* **US-NF-003:** Address GitHub Copilot review feedback ([a452c5f](https://github.com/ooples/token-optimizer-mcp/commit/a452c5f58b1c4c886c38fc46ec4bae1a29a1cb0d))
* **US-NF-004:** Address 6 additional Copilot review comments ([3a27ec2](https://github.com/ooples/token-optimizer-mcp/commit/3a27ec279de371fda7109733941df863025c64e6))
* **US-NF-004:** Address ALL remaining GitHub Copilot review comments on PR [#30](https://github.com/ooples/token-optimizer-mcp/issues/30) ([37e6c09](https://github.com/ooples/token-optimizer-mcp/commit/37e6c093a78c93ef858646f8f5be32fb1003da6e))
* **US-NF-004:** Address final Copilot review comment - escape JSON in script tags ([6630665](https://github.com/ooples/token-optimizer-mcp/commit/663066520c5df73ad5309e1359c2e7f4c35321ce))
* **US-NF-004:** Address GitHub Copilot security review comments ([f3f6467](https://github.com/ooples/token-optimizer-mcp/commit/f3f646729cd55cd700c9c767982b6d16869da3af))
* **US-NF-004:** Address new GitHub Copilot review comments from 05:36:57Z ([495791f](https://github.com/ooples/token-optimizer-mcp/commit/495791fdff24eb728eca906156545f647814d4a7))
* **US-NF-005:** Address GitHub Copilot review comments ([57175dc](https://github.com/ooples/token-optimizer-mcp/commit/57175dc04d48381bc74c4d2b5f01bf81553cf436))
* **US-NF-005:** Address GitHub Copilot review comments ([5d73bfb](https://github.com/ooples/token-optimizer-mcp/commit/5d73bfba6244f4bd6937d1adaa5da43f5d24a2b4))
* **US-NF-005:** Address latest GitHub Copilot review comments ([9479a41](https://github.com/ooples/token-optimizer-mcp/commit/9479a4102332bad272076e35d36da2458885ff1e))
* **US-PA-004:** Address ALL 14 Copilot feedback items - performance, security, and correctness ([b8796ef](https://github.com/ooples/token-optimizer-mcp/commit/b8796ef4ca7cadb6a5430f7dfba438c7e1019413))
* use consistent double-quote encoding for Buffer.from() in cache-compression.ts ([1576531](https://github.com/ooples/token-optimizer-mcp/commit/1576531103e7febc739178da7be86a2c6f16392f))
* Use Number.isFinite and remove HTML escape from CSS class ([4574a44](https://github.com/ooples/token-optimizer-mcp/commit/4574a445ca3984f74b47a0db98b60478fb1d44eb))
* User Story [#1](https://github.com/ooples/token-optimizer-mcp/issues/1) - Fix Widespread Type Mismatches ([c3d6a26](https://github.com/ooples/token-optimizer-mcp/commit/c3d6a262ab55113d90b352e7cd407c77f9a388e5))
* User Story [#2](https://github.com/ooples/token-optimizer-mcp/issues/2) - Fix TokenCountResult Object Usage ([bbed3d2](https://github.com/ooples/token-optimizer-mcp/commit/bbed3d2c2c9f67b8dda3eb408a30c6c302e8ae86))
* User Story [#3](https://github.com/ooples/token-optimizer-mcp/issues/3) - Resolve Missing Module Exports ([ab04ce3](https://github.com/ooples/token-optimizer-mcp/commit/ab04ce3c5c545ea6438cfd8a1d0f71e7075546d5))
* User Story [#4](https://github.com/ooples/token-optimizer-mcp/issues/4) - Correct TypeScript Module and Type Imports ([e1229e7](https://github.com/ooples/token-optimizer-mcp/commit/e1229e71fffd0e2b54f346536be5921d6d08d5c7))
* **wiki:** stored text cannot forge lines in the model's context ([#324](https://github.com/ooples/token-optimizer-mcp/issues/324)) ([b632391](https://github.com/ooples/token-optimizer-mcp/commit/b632391375799aab6d18b25b9c45685f71ca686b))
* **wiki:** the semantic harvest was implemented but never invoked ([#229](https://github.com/ooples/token-optimizer-mcp/issues/229)) ([895f14b](https://github.com/ooples/token-optimizer-mcp/commit/895f14b590e8f3b7cdbc3416f5dbf4406ac0f180))
* windows command-output parsing was wrong in five dispatched tools ([#218](https://github.com/ooples/token-optimizer-mcp/issues/218)) ([9f8a63d](https://github.com/ooples/token-optimizer-mcp/commit/9f8a63d35e8f515b48351d9debf6b41d61acdb60))
* windows installation and documentation improvements ([#96](https://github.com/ooples/token-optimizer-mcp/issues/96)) ([42da940](https://github.com/ooples/token-optimizer-mcp/commit/42da940d806dcf2cbcd9c9723240958c7503daa8))


### Performance

* optimize powershell hooks from 50-70ms to &lt;10ms overhead ([#108](https://github.com/ooples/token-optimizer-mcp/issues/108)) ([718b36a](https://github.com/ooples/token-optimizer-mcp/commit/718b36a8dc7c1729232abfb794d4952285652bdf))
* **US-NF-001:** Optimize line buffer and address performance concerns (iteration 3) ([23c8b1a](https://github.com/ooples/token-optimizer-mcp/commit/23c8b1a6625bbfac814e5576fe55de55585f8e4d))


### Reverts

* **ci:** skip jobs on release PRs again, now that nothing requires them ([#207](https://github.com/ooples/token-optimizer-mcp/issues/207)) ([e9a522a](https://github.com/ooples/token-optimizer-mcp/commit/e9a522a8167be4a1c4d7f05b09b432271a5465a9))


### Refactoring

* Address GitHub Copilot code review comments ([4edbca0](https://github.com/ooples/token-optimizer-mcp/commit/4edbca0f83aec6c20ce266732d3ffe3355d14c93))
* eliminate global state pattern for dependency injection ([#89](https://github.com/ooples/token-optimizer-mcp/issues/89)) ([58ee8c6](https://github.com/ooples/token-optimizer-mcp/commit/58ee8c65b877ebac1fd9fa4977630463a1cef7c6))
* unify session logging to jsonl format ([#90](https://github.com/ooples/token-optimizer-mcp/issues/90)) ([3307f0d](https://github.com/ooples/token-optimizer-mcp/commit/3307f0de52d17572b0ff35e4463185b7c33d8015))
* **US-CI-001:** Refactor global state management ([7b0625c](https://github.com/ooples/token-optimizer-mcp/commit/7b0625caf2dae702e7136a2d561944cfd11273a7))
* **US-CI-001:** Refactor global state management ([3b48392](https://github.com/ooples/token-optimizer-mcp/commit/3b48392b0523053977be5244f9dbf00a590e96c2))
* **US-CI-001:** Remove 103 unused declarations across 31 files ([7f49dde](https://github.com/ooples/token-optimizer-mcp/commit/7f49dde1a811bb8d952f844c303387abc0d8b92a))
* **US-CI-001:** Remove 103 unused declarations across 31 files ([0f0c872](https://github.com/ooples/token-optimizer-mcp/commit/0f0c872741b0c8c00730b7dce9017336b38d3a0c))
* **US-CI-002:** Unify session logging format ([b9c2264](https://github.com/ooples/token-optimizer-mcp/commit/b9c22641eef3b93602157caf03a889731d637d5a))
* **US-CI-002:** Unify session logging format and analysis ([30b7687](https://github.com/ooples/token-optimizer-mcp/commit/30b76875d023ff94fad622708966550e88f4f7ff))
* **US-CI-003:** Replace hardcoded os.homedir() ([f59dfb5](https://github.com/ooples/token-optimizer-mcp/commit/f59dfb5354105f6cae78fc2dc078570dc1cbf98d))
* **US-CI-003:** Replace hardcoded os.homedir() with configurable path ([07f63c9](https://github.com/ooples/token-optimizer-mcp/commit/07f63c9399f7c7af6962841febd2e461c448a468))


### Documentation

* Add clarifying comments for Copilot review feedback ([fdd00f0](https://github.com/ooples/token-optimizer-mcp/commit/fdd00f0e3d03b65fae0b35a90924e61378a98b0a))
* add comprehensive JSDoc for calculateAnomalyScore method ([65d2a01](https://github.com/ooples/token-optimizer-mcp/commit/65d2a0171d0dc82a911a0be665f85df28c917111))
* add comprehensive monitoring and troubleshooting guide ([#106](https://github.com/ooples/token-optimizer-mcp/issues/106)) ([cf63f70](https://github.com/ooples/token-optimizer-mcp/commit/cf63f70753978c4264efc296a4856ac36653f7f8))
* add hooks performance optimization plan ([#86](https://github.com/ooples/token-optimizer-mcp/issues/86)) ([9cf0f2a](https://github.com/ooples/token-optimizer-mcp/commit/9cf0f2abe28fec5b864df0990fe15053c6b0e356))
* Address Copilot comments on collision probability and error messages ([2be626c](https://github.com/ooples/token-optimizer-mcp/commit/2be626cb7e7a49e981a1efbe4cd062743c918ef7))
* **analysis:** comprehensive token optimization analysis and project cleanup ([076f933](https://github.com/ooples/token-optimizer-mcp/commit/076f933f4d21549362bc62fa5f8fce438a3d606e))
* **analysis:** Token optimization analysis and project cleanup ([760556a](https://github.com/ooples/token-optimizer-mcp/commit/760556ac04d253fe071675ee4be4b9bc7b001bbe))
* expand MCP setup and restore README reference ([#194](https://github.com/ooples/token-optimizer-mcp/issues/194)) ([ab89d8f](https://github.com/ooples/token-optimizer-mcp/commit/ab89d8f9826145b996a49dc9a81ecebe446471ac))
* Move anomaly scoring removal note to imports section ([4c4c84b](https://github.com/ooples/token-optimizer-mcp/commit/4c4c84b3dffd780866b72bc672c51f2609dc20c1))
* **US-NF-001:** Update CLI_INTEGRATION.md documentation example ([90d0614](https://github.com/ooples/token-optimizer-mcp/commit/90d06143fb963c3f33ef199f2e7be2f8e7adaaa0))


### CI/CD

* add Codex Autofix CI ([20921ff](https://github.com/ooples/token-optimizer-mcp/commit/20921ffb845f7a2bff132038f21761621e84bd5b))
* add HOL plugin scanner for awesome-codex-plugins listing ([#192](https://github.com/ooples/token-optimizer-mcp/issues/192)) ([093e6ea](https://github.com/ooples/token-optimizer-mcp/commit/093e6eab22fd0ae38449d25523b1d8286bd553ae))
* cancel a PR's runs when it closes, instead of leaving them to drain ([#210](https://github.com/ooples/token-optimizer-mcp/issues/210)) ([cf386d6](https://github.com/ooples/token-optimizer-mcp/commit/cf386d6b5ea4a5e91403aea96255b4a0f583256b))
* **codex:** ensure auto-fix runs on real failures; avoid master and missing-secret skips ([d9af9bb](https://github.com/ooples/token-optimizer-mcp/commit/d9af9bb074d9fdbe85021979242455435481e47a))
* **codex:** move OPENAI_API_KEY check to step-level and guard all steps; remove secrets usage from job if ([530d178](https://github.com/ooples/token-optimizer-mcp/commit/530d1789d031f0b91890b7811fbedd669d6d6ad3))
* **codex:** run on CI/Quality Gates failures only; skip master and require OPENAI_API_KEY to avoid false skips ([7b62659](https://github.com/ooples/token-optimizer-mcp/commit/7b626590c86a71fb669797a7ea6b0d5befc47abb))
* Disable coverage thresholds for initial release ([770b4ec](https://github.com/ooples/token-optimizer-mcp/commit/770b4ecc01f18104cad2c197d5dc27e325cd1305))
* **release:** harden release pipeline + version-info notifications ([#170](https://github.com/ooples/token-optimizer-mcp/issues/170)) ([9e5a06c](https://github.com/ooples/token-optimizer-mcp/commit/9e5a06cad1e204b77349c03e1da0520ae3af54c0))
* **release:** migrate to release-please with oidc npm publishing ([#182](https://github.com/ooples/token-optimizer-mcp/issues/182)) ([22462c7](https://github.com/ooples/token-optimizer-mcp/commit/22462c7d613b874e79fd433aecdeba4cae4052f0))
* **release:** remove @semantic-release/git and changelog to comply with branch protection; use GitHub release notes only ([d121d4a](https://github.com/ooples/token-optimizer-mcp/commit/d121d4ad23fe3a5a0ca90a1427e523d2dd9d552f))
* **release:** stop branch pushes; rely on GitHub release notes ([b55f5fb](https://github.com/ooples/token-optimizer-mcp/commit/b55f5fb5d94dfd2f9887393b4f716607e4767840))
* skip redundant checks on release-please PRs ([#185](https://github.com/ooples/token-optimizer-mcp/issues/185)) ([f4f7e73](https://github.com/ooples/token-optimizer-mcp/commit/f4f7e73df992681d1456e59c5f60d6e2531ec8e6))
* skip redundant jobs on the release merge commit, not just the release PR ([#208](https://github.com/ooples/token-optimizer-mcp/issues/208)) ([c4945aa](https://github.com/ooples/token-optimizer-mcp/commit/c4945aacec94d04892467b5bac862a77c62517a1))

## [5.8.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.7.1...v5.8.0) (2026-08-27)


### Features

* **wiki:** a finding reaches every identical copy of its file ([#327](https://github.com/ooples/token-optimizer-mcp/issues/327)) ([9a016b6](https://github.com/ooples/token-optimizer-mcp/commit/9a016b6d23250b5ea7df4505305cc700fdea0c5e))
* **wiki:** harvest at precompact, and report the hit rate beside the balance ([#329](https://github.com/ooples/token-optimizer-mcp/issues/329)) ([ae6d53e](https://github.com/ooples/token-optimizer-mcp/commit/ae6d53eecd35da714a23a4d1bfb7fec639757357))
* **wiki:** produce findings and measure whether they pay ([#204](https://github.com/ooples/token-optimizer-mcp/issues/204), part 2 of 3) ([#328](https://github.com/ooples/token-optimizer-mcp/issues/328)) ([e672c13](https://github.com/ooples/token-optimizer-mcp/commit/e672c139fccd9c466b5cf23c1d5e5a2e6b2f2132))


### Bug Fixes

* **dashboard:** repair wiki route and plugin activity status ([#313](https://github.com/ooples/token-optimizer-mcp/issues/313)) ([d6fcc24](https://github.com/ooples/token-optimizer-mcp/commit/d6fcc2432dd291acba184d35ec72a2b16d1ad220))
* **harvest:** run the semantic harvest on the shared stop path ([#326](https://github.com/ooples/token-optimizer-mcp/issues/326)) ([0b39e7d](https://github.com/ooples/token-optimizer-mcp/commit/0b39e7d2cfa21f3b618a30586bd6eb6b1321cf0d))
* **pending:** adopt a claim stranded by a killed drainer ([#325](https://github.com/ooples/token-optimizer-mcp/issues/325)) ([877f66b](https://github.com/ooples/token-optimizer-mcp/commit/877f66b2ca71441d64798586eb061b19ef159bc5))
* **wiki:** stored text cannot forge lines in the model's context ([#324](https://github.com/ooples/token-optimizer-mcp/issues/324)) ([b632391](https://github.com/ooples/token-optimizer-mcp/commit/b632391375799aab6d18b25b9c45685f71ca686b))

## [5.7.1](https://github.com/ooples/token-optimizer-mcp/compare/v5.7.0...v5.7.1) (2026-08-23)


### Bug Fixes

* mcp server exits before registering tools on windows ([#307](https://github.com/ooples/token-optimizer-mcp/issues/307)) ([#308](https://github.com/ooples/token-optimizer-mcp/issues/308)) ([81f5d55](https://github.com/ooples/token-optimizer-mcp/commit/81f5d55953a2556bd3f872460d97ca0e40e7844e))

## [5.7.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.6.1...v5.7.0) (2026-08-10)


### Features

* add causal evidence and cross-client effectiveness ([#301](https://github.com/ooples/token-optimizer-mcp/issues/301)) ([59656c2](https://github.com/ooples/token-optimizer-mcp/commit/59656c2c64399165157ad2ba6564fef5a0991798))
* add executable UCR effectiveness proof program ([#304](https://github.com/ooples/token-optimizer-mcp/issues/304)) ([1e5def5](https://github.com/ooples/token-optimizer-mcp/commit/1e5def52ea3bc5a92f26884e4a17994f35049f54))
* **graph:** make the knowledge loop actually run -- harvest by default, and enforce recording ([#296](https://github.com/ooples/token-optimizer-mcp/issues/296)) ([8a7ebce](https://github.com/ooples/token-optimizer-mcp/commit/8a7ebce623a8a420f1f231d715da5dd21032d37d))
* implement universal cognitive runtime evidence system ([#303](https://github.com/ooples/token-optimizer-mcp/issues/303)) ([ef34b71](https://github.com/ooples/token-optimizer-mcp/commit/ef34b715fbe1b134d07cf930cd2b4450566a6dc5))


### Bug Fixes

* **decide:** a dump redirected to a file is not a dump ([#298](https://github.com/ooples/token-optimizer-mcp/issues/298)) ([eb57606](https://github.com/ooples/token-optimizer-mcp/commit/eb57606a895c71ad5cc0946bbd5b23b4516a0490))
* **forecast:** divide each arm by its own event count, not by the other's ([#297](https://github.com/ooples/token-optimizer-mcp/issues/297)) ([5491652](https://github.com/ooples/token-optimizer-mcp/commit/54916523a3c37fa57f156690beeed2fc8ee59385))

## [5.6.1](https://github.com/ooples/token-optimizer-mcp/compare/v5.6.0...v5.6.1) (2026-08-08)


### Bug Fixes

* **keepwarm,lessons:** make the tripwire reachable, the gaps per-session, the anchors real ([#295](https://github.com/ooples/token-optimizer-mcp/issues/295)) ([c22bc55](https://github.com/ooples/token-optimizer-mcp/commit/c22bc55600014c59c61e6a225034f5c6a2f20b93))
* **keepwarm,lessons:** score refreshes with the model that bought them ([#293](https://github.com/ooples/token-optimizer-mcp/issues/293)) ([ff158bf](https://github.com/ooples/token-optimizer-mcp/commit/ff158bf3d4021c5b13398392e1b28d824bebf8fc))

## [5.6.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.5.0...v5.6.0) (2026-08-08)


### Features

* **graph:** add wiki_read so agents can retrieve what the graph knows ([#281](https://github.com/ooples/token-optimizer-mcp/issues/281)) ([23f8250](https://github.com/ooples/token-optimizer-mcp/commit/23f8250d5f1df388d5c66fa1c61e603c4ee88fda))


### Bug Fixes

* **adapter:** make the non-Claude clients measure what the router measures ([#284](https://github.com/ooples/token-optimizer-mcp/issues/284)) ([d1fbf2a](https://github.com/ooples/token-optimizer-mcp/commit/d1fbf2ab182dc6abbd8af52cf9a460afe1dedd0e))
* **audit:** stop the report misstating its own numbers ([#286](https://github.com/ooples/token-optimizer-mcp/issues/286)) ([7a6f4be](https://github.com/ooples/token-optimizer-mcp/commit/7a6f4be8d55655800fded2c2f63702e996b0f34c))
* **cache:** stop reporting invented cache costs ([#282](https://github.com/ooples/token-optimizer-mcp/issues/282)) ([7ad35b0](https://github.com/ooples/token-optimizer-mcp/commit/7ad35b08dc6dc2868b7b939566d425305176190c))
* **consolidate:** score against the inputs the module says it uses ([#285](https://github.com/ooples/token-optimizer-mcp/issues/285)) ([b10eba0](https://github.com/ooples/token-optimizer-mcp/commit/b10eba0e7ab6b84dabd04ca3af039285937b6ee8))
* **curate:** stop losing curated claims to a single failed append ([#283](https://github.com/ooples/token-optimizer-mcp/issues/283)) ([6f66b55](https://github.com/ooples/token-optimizer-mcp/commit/6f66b55d2a5c1a8d2aabfac370ddf7e5516bf57f))
* **disclose:** never withhold content while reporting nothing omitted ([#288](https://github.com/ooples/token-optimizer-mcp/issues/288)) ([dc65b9c](https://github.com/ooples/token-optimizer-mcp/commit/dc65b9cf85bf551068b6203e1d133003d7c622ee))
* **doctor:** stop reporting a broken install as healthy ([#287](https://github.com/ooples/token-optimizer-mcp/issues/287)) ([04d17b5](https://github.com/ooples/token-optimizer-mcp/commit/04d17b524e793af79fa7f4b9651d0eb41988654a))
* **expand:** serve only what the pointer actually points at ([#289](https://github.com/ooples/token-optimizer-mcp/issues/289)) ([a4be61e](https://github.com/ooples/token-optimizer-mcp/commit/a4be61e9a0ec7175335093666c50be1e2716271d))
* **fleet:** scope the scan, weight the comparison, read nothing before consent ([#290](https://github.com/ooples/token-optimizer-mcp/issues/290)) ([4473a07](https://github.com/ooples/token-optimizer-mcp/commit/4473a07b93b36b087fd707355d9f6963d2da1925))
* **forecast:** let the panel publish a result that is bad for the product ([#291](https://github.com/ooples/token-optimizer-mcp/issues/291)) ([9efbe84](https://github.com/ooples/token-optimizer-mcp/commit/9efbe849f0625a1c8ec418caaffca2e5d99f6a49))
* **graph:** key unrooted files on a stable graph, not the caller cwd ([#279](https://github.com/ooples/token-optimizer-mcp/issues/279)) ([87f50d7](https://github.com/ooples/token-optimizer-mcp/commit/87f50d738e7358f87d5ae69c069e09ce5329ba31))

## [5.5.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.4.3...v5.5.0) (2026-08-07)


### Features

* **graph:** carry process lessons across projects ([#278](https://github.com/ooples/token-optimizer-mcp/issues/278)) ([7c6bedd](https://github.com/ooples/token-optimizer-mcp/commit/7c6bedd2f30e4544e4233439de96bc395d688b5f))
* **hooks:** ask the running session to record what it worked out ([#264](https://github.com/ooples/token-optimizer-mcp/issues/264)) ([dc39357](https://github.com/ooples/token-optimizer-mcp/commit/dc39357ca8f90bcdbc1781036d44478178831a49))


### Bug Fixes

* **ci:** run every verification gate, and repair the four that had rotted ([#272](https://github.com/ooples/token-optimizer-mcp/issues/272)) ([e02bce1](https://github.com/ooples/token-optimizer-mcp/commit/e02bce1bf65ec337206f533a7f62763a24104104))
* **edit:** report the real line count, not the split artefact ([#274](https://github.com/ooples/token-optimizer-mcp/issues/274)) ([564e5c6](https://github.com/ooples/token-optimizer-mcp/commit/564e5c6a1b8ebb9f6dd8ce41e4fcd22c39370cfd))
* **hooks:** a path must not be able to abort the hook process ([#265](https://github.com/ooples/token-optimizer-mcp/issues/265)) ([44c673b](https://github.com/ooples/token-optimizer-mcp/commit/44c673b1afee5ea0bff9cf5e31485d900a44f37e))
* **hooks:** look up command findings in the project the command runs in ([#271](https://github.com/ooples/token-optimizer-mcp/issues/271)) ([b19f1c5](https://github.com/ooples/token-optimizer-mcp/commit/b19f1c5d5b9a0aeab1185a87221e066756ac1324))
* **hooks:** say what was observed about an unreadable anchor ([#266](https://github.com/ooples/token-optimizer-mcp/issues/266)) ([8c00f5b](https://github.com/ooples/token-optimizer-mcp/commit/8c00f5b4021bcfa9e85adda03a3b4e6dc1279eb6))
* **hooks:** scope read state per agent, not per session ([#269](https://github.com/ooples/token-optimizer-mcp/issues/269)) ([19d326a](https://github.com/ooples/token-optimizer-mcp/commit/19d326a2e36b00aa0f33c2da61ddc887a436d260))
* **hooks:** serve findings before re-indexing, so an external change shows stale ([#275](https://github.com/ooples/token-optimizer-mcp/issues/275)) ([34c82f0](https://github.com/ooples/token-optimizer-mcp/commit/34c82f02088f07743fc204880b2bc6af3f9668e6))
* **inject:** match the framing to the evidence, not to the strongest wording available ([#270](https://github.com/ooples/token-optimizer-mcp/issues/270)) ([c29896f](https://github.com/ooples/token-optimizer-mcp/commit/c29896f18b5484c2047103d59063f40d0a17e03d))
* **mcp:** close the two verification holes that let bad schemas and stale manifests through ([#262](https://github.com/ooples/token-optimizer-mcp/issues/262)) ([a6fa649](https://github.com/ooples/token-optimizer-mcp/commit/a6fa6498e8f7342be84849332a3b358052aed140))
* **search:** let path name a single file instead of answering zero ([#263](https://github.com/ooples/token-optimizer-mcp/issues/263)) ([359f556](https://github.com/ooples/token-optimizer-mcp/commit/359f556c74d7dc22ccb011d45c787bee099b8041))
* **search:** make count mode actually return counts ([#273](https://github.com/ooples/token-optimizer-mcp/issues/273)) ([710747d](https://github.com/ooples/token-optimizer-mcp/commit/710747d78480c4c6275112b8709c98cb8c6061ca))
* **search:** say when a literal zero was hiding a regex match ([#276](https://github.com/ooples/token-optimizer-mcp/issues/276)) ([c11a20e](https://github.com/ooples/token-optimizer-mcp/commit/c11a20ee2cdc713b1f28918a0e642260a3176860))
* **search:** stop hiding every dot-directory, including .github ([#268](https://github.com/ooples/token-optimizer-mcp/issues/268)) ([4f59b98](https://github.com/ooples/token-optimizer-mcp/commit/4f59b98d0cf665b87a9fc0e66f444eb0e514d438))

## [5.4.3](https://github.com/ooples/token-optimizer-mcp/compare/v5.4.2...v5.4.3) (2026-08-05)


### Bug Fixes

* **hooks:** a write is not a read, and compaction ends the claim ([#257](https://github.com/ooples/token-optimizer-mcp/issues/257)) ([84525c2](https://github.com/ooples/token-optimizer-mcp/commit/84525c206ab60ac3351b7ab7850c2d956e75fbbd))
* **mcp:** declare the options tools accept, and ratchet the rest ([#258](https://github.com/ooples/token-optimizer-mcp/issues/258)) ([30dc75d](https://github.com/ooples/token-optimizer-mcp/commit/30dc75d82c74c6cbb3c99746b0ff1335703ea70f))
* **mcp:** finish declaring every option every tool accepts ([#261](https://github.com/ooples/token-optimizer-mcp/issues/261)) ([03828e9](https://github.com/ooples/token-optimizer-mcp/commit/03828e9516a23f8052e4fc9a1cf8b4a0abbee3c1))
* **release:** resolve the mcp spec at launch instead of pinning it in git ([#256](https://github.com/ooples/token-optimizer-mcp/issues/256)) ([9672b39](https://github.com/ooples/token-optimizer-mcp/commit/9672b39e4cfe6b8818b342b85b95d8e6d0511e31))
* **release:** verify the released tag instead of repairing it first ([#260](https://github.com/ooples/token-optimizer-mcp/issues/260)) ([da596ca](https://github.com/ooples/token-optimizer-mcp/commit/da596ca70cae51f4dcffa0e0e8a5339087a207c3))

## [5.4.2](https://github.com/ooples/token-optimizer-mcp/compare/v5.4.1...v5.4.2) (2026-08-05)


### Bug Fixes

* **release:** repair the pins during the release instead of failing on them ([#253](https://github.com/ooples/token-optimizer-mcp/issues/253)) ([5c005f3](https://github.com/ooples/token-optimizer-mcp/commit/5c005f319c5facb4ce4605104c155a1a8bb0abdc))
* **release:** sync pinned specs from an event that actually fires ([#254](https://github.com/ooples/token-optimizer-mcp/issues/254)) ([e7ff984](https://github.com/ooples/token-optimizer-mcp/commit/e7ff984ef88adc1be6cccb5ce28e77114063de00))

## [5.4.1](https://github.com/ooples/token-optimizer-mcp/compare/v5.4.0...v5.4.1) (2026-08-05)


### Bug Fixes

* **doctor:** report whether finding extraction is actually running ([#247](https://github.com/ooples/token-optimizer-mcp/issues/247)) ([7367250](https://github.com/ooples/token-optimizer-mcp/commit/7367250ecbea9a293a576b7edbe5214b7424b322))
* **harness:** make the a/b measurement instrument repeatable ([#246](https://github.com/ooples/token-optimizer-mcp/issues/246)) ([219d62a](https://github.com/ooples/token-optimizer-mcp/commit/219d62ad49f7b81c8993791c70486c5d5385795a))
* **metrics:** the causal measurement had never produced a single reading ([#251](https://github.com/ooples/token-optimizer-mcp/issues/251)) ([516a032](https://github.com/ooples/token-optimizer-mcp/commit/516a032b418c87bc8ee13a5bd6fdd5c0c1b846cd))
* **release:** unblock the 5.4.0 publish, and stop the harvest worker crashing on exit ([#245](https://github.com/ooples/token-optimizer-mcp/issues/245)) ([1ecd165](https://github.com/ooples/token-optimizer-mcp/commit/1ecd165227cfa6a242ef3fa71f4eeafc710f37ba))
* **search:** honour `path` and survive oversized result sets ([#249](https://github.com/ooples/token-optimizer-mcp/issues/249)) ([bf3870f](https://github.com/ooples/token-optimizer-mcp/commit/bf3870fcec33e7bf004c734f91b7790f266c3585))

## [5.4.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.3.6...v5.4.0) (2026-08-04)


### Features

* **hooks:** wire co-occurrence to restoration, so the graph can predict ([#240](https://github.com/ooples/token-optimizer-mcp/issues/240)) ([41e422f](https://github.com/ooples/token-optimizer-mcp/commit/41e422fbdc76a2cae6c9aae6f264453670ee89f2))
* **inject:** deliver findings to the model, and measure whether it helps ([#235](https://github.com/ooples/token-optimizer-mcp/issues/235)) ([e1f6d2f](https://github.com/ooples/token-optimizer-mcp/commit/e1f6d2f05ea4f4ac559f71841809a1712bc1a54e))
* **lessons:** capture user corrections and deliver them back as instructions ([#236](https://github.com/ooples/token-optimizer-mcp/issues/236)) ([f2fa046](https://github.com/ooples/token-optimizer-mcp/commit/f2fa046a97dc13907d6bdcc0dddb8159336e1c93))


### Bug Fixes

* **ci:** let the release-pin sync be triggered manually ([#244](https://github.com/ooples/token-optimizer-mcp/issues/244)) ([16fc1c5](https://github.com/ooples/token-optimizer-mcp/commit/16fc1c5061bfccb9f4d7d32f85552cd39cdb8344))
* install verification, plugin-aware doctor, and release pin drift ([#241](https://github.com/ooples/token-optimizer-mcp/issues/241)) ([0295a23](https://github.com/ooples/token-optimizer-mcp/commit/0295a23d0b46919c80b53524eaa0f0de335692dc))
* **paths:** canonicalise to a fixed point by construction, not by patching ([#243](https://github.com/ooples/token-optimizer-mcp/issues/243)) ([1ce8308](https://github.com/ooples/token-optimizer-mcp/commit/1ce8308fd31625ce18d7b6b223b0bac1b651307a))

## [5.3.6](https://github.com/ooples/token-optimizer-mcp/compare/v5.3.5...v5.3.6) (2026-08-04)


### Bug Fixes

* **cache:** original and compressed sizes were recorded backwards ([#227](https://github.com/ooples/token-optimizer-mcp/issues/227)) ([74f16c6](https://github.com/ooples/token-optimizer-mcp/commit/74f16c6b98862c7a34c4770d45181ddbaf9196e2))
* **curate:** a correction claimed to be a person's assertion ([#232](https://github.com/ooples/token-optimizer-mcp/issues/232)) ([5d822f3](https://github.com/ooples/token-optimizer-mcp/commit/5d822f38706d42ad7aadfa8f942b7bc936ce31f5))
* **security:** scanner reported no findings over live-format api keys ([#223](https://github.com/ooples/token-optimizer-mcp/issues/223)) ([beb2ebd](https://github.com/ooples/token-optimizer-mcp/commit/beb2ebdd9065ff68f7b31492875025c39a48b97d))
* **server:** mistyped tool arguments were dropped instead of refused ([#228](https://github.com/ooples/token-optimizer-mcp/issues/228)) ([800d4e0](https://github.com/ooples/token-optimizer-mcp/commit/800d4e00fbdcf36a4c75aa7e0422bc9315819798))
* smart_ast_grep was entirely non-functional on windows, and said nothing ([#226](https://github.com/ooples/token-optimizer-mcp/issues/226)) ([56873b9](https://github.com/ooples/token-optimizer-mcp/commit/56873b93d7d04c11d8167b66f55d07dc3aa7f387))
* smart_env returned every .env value; smart_dependencies never delivered its graph ([#225](https://github.com/ooples/token-optimizer-mcp/issues/225)) ([a963995](https://github.com/ooples/token-optimizer-mcp/commit/a963995b91d2865b4f9c982d29877f8f7d5d2ce8))
* **smart-edit:** a silently dropped edit reported success ([#231](https://github.com/ooples/token-optimizer-mcp/issues/231)) ([31c5394](https://github.com/ooples/token-optimizer-mcp/commit/31c53946d59cce5e4e8f959a487d921cd62e5001))
* **tokens:** counting silently fell back to length/4, overstating savings by up to 130% ([#222](https://github.com/ooples/token-optimizer-mcp/issues/222)) ([97a9027](https://github.com/ooples/token-optimizer-mcp/commit/97a90276f41670a857103b859d63566d820c0317))
* **wiki:** the semantic harvest was implemented but never invoked ([#229](https://github.com/ooples/token-optimizer-mcp/issues/229)) ([895f14b](https://github.com/ooples/token-optimizer-mcp/commit/895f14b590e8f3b7cdbc3416f5dbf4406ac0f180))

## [5.3.5](https://github.com/ooples/token-optimizer-mcp/compare/v5.3.4...v5.3.5) (2026-08-02)


### Bug Fixes

* a fresh windows clone failed its own test suite and format check ([#220](https://github.com/ooples/token-optimizer-mcp/issues/220)) ([9709c12](https://github.com/ooples/token-optimizer-mcp/commit/9709c12db8f689bd4961989b8f31375052db0d88))

## [5.3.4](https://github.com/ooples/token-optimizer-mcp/compare/v5.3.3...v5.3.4) (2026-08-01)


### Bug Fixes

* windows command-output parsing was wrong in five dispatched tools ([#218](https://github.com/ooples/token-optimizer-mcp/issues/218)) ([9f8a63d](https://github.com/ooples/token-optimizer-mcp/commit/9f8a63d35e8f515b48351d9debf6b41d61acdb60))

## [5.3.3](https://github.com/ooples/token-optimizer-mcp/compare/v5.3.2...v5.3.3) (2026-08-01)


### Bug Fixes

* consolidate every live-test fix into one verified release ([#217](https://github.com/ooples/token-optimizer-mcp/issues/217)) ([ea8d1aa](https://github.com/ooples/token-optimizer-mcp/commit/ea8d1aa1b11ca8a6a180362fe53d3a3a898ca033))
* **doctor:** give each run a fresh session, so it stops failing its own second run ([#213](https://github.com/ooples/token-optimizer-mcp/issues/213)) ([8761b1f](https://github.com/ooples/token-optimizer-mcp/commit/8761b1f22ee21d75aa86deedea4cebf8a98493cb))
* **graph:** wire the memory half — harvest had no call site anywhere ([#215](https://github.com/ooples/token-optimizer-mcp/issues/215)) ([efa10ab](https://github.com/ooples/token-optimizer-mcp/commit/efa10ab9284cb8bcbc491907d61870d6109ce313))
* **install:** make wiring recoverable when npm blocks postinstall ([#214](https://github.com/ooples/token-optimizer-mcp/issues/214)) ([f6e146c](https://github.com/ooples/token-optimizer-mcp/commit/f6e146c0dfd510b3425efc1880a16abc94f405d2))

## [5.3.2](https://github.com/ooples/token-optimizer-mcp/compare/v5.3.1...v5.3.2) (2026-07-31)


### Bug Fixes

* **pkg:** ship the enforcement hooks and installer scripts ([#211](https://github.com/ooples/token-optimizer-mcp/issues/211)) ([d05babd](https://github.com/ooples/token-optimizer-mcp/commit/d05babd0e86ae900f3965ccfad769a5c0dba1106))

## [5.3.1](https://github.com/ooples/token-optimizer-mcp/compare/v5.3.0...v5.3.1) (2026-07-31)


### CI/CD

* cancel a PR's runs when it closes, instead of leaving them to drain ([#210](https://github.com/ooples/token-optimizer-mcp/issues/210)) ([cf386d6](https://github.com/ooples/token-optimizer-mcp/commit/cf386d6b5ea4a5e91403aea96255b4a0f583256b))
* skip redundant jobs on the release merge commit, not just the release PR ([#208](https://github.com/ooples/token-optimizer-mcp/issues/208)) ([c4945aa](https://github.com/ooples/token-optimizer-mcp/commit/c4945aacec94d04892467b5bac862a77c62517a1))

## [5.3.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.2.0...v5.3.0) (2026-07-31)


### Features

* optimize tokens by default on install, across all 15 CLI clients ([#203](https://github.com/ooples/token-optimizer-mcp/issues/203)) ([44d633b](https://github.com/ooples/token-optimizer-mcp/commit/44d633b1ba4a5cb862d5ac3f0251351c4605b147))


### Bug Fixes

* **ci:** let release PRs satisfy required checks instead of skipping them ([#206](https://github.com/ooples/token-optimizer-mcp/issues/206)) ([97daa05](https://github.com/ooples/token-optimizer-mcp/commit/97daa05d1fe324744499ef445afb81ffadc09722))

## [5.2.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.1.3...v5.2.0) (2026-07-21)


### Features

* add native optimization hooks across cli tools ([#197](https://github.com/ooples/token-optimizer-mcp/issues/197)) ([ac35492](https://github.com/ooples/token-optimizer-mcp/commit/ac354921de8faeb42e9d00014d0b1328dfc98148))

## [5.1.3](https://github.com/ooples/token-optimizer-mcp/compare/v5.1.2...v5.1.3) (2026-07-21)


### Bug Fixes

* **plugins:** track plugin .mcp.json + add native Codex plugin packaging ([#191](https://github.com/ooples/token-optimizer-mcp/issues/191)) ([9a58141](https://github.com/ooples/token-optimizer-mcp/commit/9a581416cb728df3fc0e17162c69e296decf00a0))


### Documentation

* expand MCP setup and restore README reference ([#194](https://github.com/ooples/token-optimizer-mcp/issues/194)) ([ab89d8f](https://github.com/ooples/token-optimizer-mcp/commit/ab89d8f9826145b996a49dc9a81ecebe446471ac))


### CI/CD

* add HOL plugin scanner for awesome-codex-plugins listing ([#192](https://github.com/ooples/token-optimizer-mcp/issues/192)) ([093e6ea](https://github.com/ooples/token-optimizer-mcp/commit/093e6eab22fd0ae38449d25523b1d8286bd553ae))

## [5.1.2](https://github.com/ooples/token-optimizer-mcp/compare/v5.1.1...v5.1.2) (2026-07-20)


### Bug Fixes

* **cache:** self-heal from a corrupt database file on every retry ([#188](https://github.com/ooples/token-optimizer-mcp/issues/188)) ([4b415ea](https://github.com/ooples/token-optimizer-mcp/commit/4b415ea73a4fca4ebde391ba8e05a42390b49af0))

## [5.1.1](https://github.com/ooples/token-optimizer-mcp/compare/v5.1.0...v5.1.1) (2026-07-20)


### Bug Fixes

* **release:** drop the redundant full test rerun from npm publish ([#186](https://github.com/ooples/token-optimizer-mcp/issues/186)) ([6874f62](https://github.com/ooples/token-optimizer-mcp/commit/6874f62fb58c0ccb44518b1fa4eb8df700276567))

## [5.1.0](https://github.com/ooples/token-optimizer-mcp/compare/v5.0.1...v5.1.0) (2026-07-20)


### Features

* **analytics:** auto-record token savings + add get_optimization_report ([#181](https://github.com/ooples/token-optimizer-mcp/issues/181)) ([2b26227](https://github.com/ooples/token-optimizer-mcp/commit/2b2622738adf664e4c3d4d5a2e608d723a6bc040))
* implement background optimization with immediate session persistence ([770cf31](https://github.com/ooples/token-optimizer-mcp/commit/770cf3164a9010d90e1848672b3b257e20889fd2))
* implement LRU cache and sophisticated token counting (issues [#4](https://github.com/ooples/token-optimizer-mcp/issues/4) and [#5](https://github.com/ooples/token-optimizer-mcp/issues/5)) ([#127](https://github.com/ooples/token-optimizer-mcp/issues/127)) ([3f069f7](https://github.com/ooples/token-optimizer-mcp/commit/3f069f7ce82ed9f25ca30d8c9ad154425090f63d))
* optimization platform — config, tokenizers, LRU cache, sessions, context-delta ([#163](https://github.com/ooples/token-optimizer-mcp/issues/163)) ([b316152](https://github.com/ooples/token-optimizer-mcp/commit/b3161526b031adec6a30e575c7152b5e7b69f4ec))
* **packaging:** claude code plugin + gemini/codex/opencode/copilot integrations ([#180](https://github.com/ooples/token-optimizer-mcp/issues/180)) ([a694fc1](https://github.com/ooples/token-optimizer-mcp/commit/a694fc1ac5da917f24ef54579d50f59919fccad0))


### Bug Fixes

* add missing items schema to array tool parameters ([#153](https://github.com/ooples/token-optimizer-mcp/issues/153)) ([#154](https://github.com/ooples/token-optimizer-mcp/issues/154)) ([06b941f](https://github.com/ooples/token-optimizer-mcp/commit/06b941f1b65f85758f1efa16839c0629826a61d0))
* add semantic-release git plugin and sync package.json to v5.0.1 ([#119](https://github.com/ooples/token-optimizer-mcp/issues/119)) ([31efcf3](https://github.com/ooples/token-optimizer-mcp/commit/31efcf3deb26002eacc979650b0f2e3b04bdcc2f))
* **cache:** tolerate a directory passed as the cache engine db path ([#171](https://github.com/ooples/token-optimizer-mcp/issues/171)) ([d933821](https://github.com/ooples/token-optimizer-mcp/commit/d9338213fb5c2264d67b9ed3f74bf48b226bd601))
* **ci,security:** repair release pipeline (Node 22) and stop tracking .mcp.json ([#179](https://github.com/ooples/token-optimizer-mcp/issues/179)) ([73550bc](https://github.com/ooples/token-optimizer-mcp/commit/73550bcd401adf0554e228f1abaeb87e5b464631))
* **hooks,tools:** close gap-analysis findings on top of [#175](https://github.com/ooples/token-optimizer-mcp/issues/175) ([#176](https://github.com/ooples/token-optimizer-mcp/issues/176)) ([99252ae](https://github.com/ooples/token-optimizer-mcp/commit/99252aec279a1767878136fe59712f006018de26))
* move background optimization and session fixes to PR (wrongly committed to master) ([#128](https://github.com/ooples/token-optimizer-mcp/issues/128)) ([1ac3e7b](https://github.com/ooples/token-optimizer-mcp/commit/1ac3e7bdd7f62cceb384dd999db3a082337f4501))
* **release:** recognize existing vX.Y.Z tags in release-please ([#183](https://github.com/ooples/token-optimizer-mcp/issues/183)) ([4637590](https://github.com/ooples/token-optimizer-mcp/commit/46375901ca6b357c01f28e254f2d43219d7b82ef))
* remove conflicting Start-Process parameters causing silent failures ([6e43e7c](https://github.com/ooples/token-optimizer-mcp/commit/6e43e7c1b1bdcafca902e26909208403543a7db2))
* repair broken PowerShell hooks and 5 MCP tool bugs (15 user-reported issues) ([#175](https://github.com/ooples/token-optimizer-mcp/issues/175)) ([ced86aa](https://github.com/ooples/token-optimizer-mcp/commit/ced86aa345771e33e71d9db7ff5a899ef88acf28))
* resolve powershell parse errors and session file corruption ([ceaf8e1](https://github.com/ooples/token-optimizer-mcp/commit/ceaf8e10d9df76022074a8c331cbb3ed25163f03))
* **security:** eliminate os command injection across smart_* tools ([#169](https://github.com/ooples/token-optimizer-mcp/issues/169)) ([b4ee96d](https://github.com/ooples/token-optimizer-mcp/commit/b4ee96dac799cbfba0a9f9c17844ce9d613cbcc7))
* **server:** exit stdio server on stdin close to prevent Windows orphan-leak ([#177](https://github.com/ooples/token-optimizer-mcp/issues/177)) ([0408bee](https://github.com/ooples/token-optimizer-mcp/commit/0408bee1a476814be830d12adec05a4165eeff95))
* **smart_read:** guard zod-v4 error issues and require non-empty path ([#167](https://github.com/ooples/token-optimizer-mcp/issues/167)) ([4ae7c35](https://github.com/ooples/token-optimizer-mcp/commit/4ae7c351659b3a1a7f741f6dc427577aead9fdd8))


### CI/CD

* **release:** harden release pipeline + version-info notifications ([#170](https://github.com/ooples/token-optimizer-mcp/issues/170)) ([9e5a06c](https://github.com/ooples/token-optimizer-mcp/commit/9e5a06cad1e204b77349c03e1da0520ae3af54c0))
* **release:** migrate to release-please with oidc npm publishing ([#182](https://github.com/ooples/token-optimizer-mcp/issues/182)) ([22462c7](https://github.com/ooples/token-optimizer-mcp/commit/22462c7d613b874e79fd433aecdeba4cae4052f0))

## [5.0.2] - 2026-05-28

### Fixed
- **`smart_read` crashed with `Cannot read properties of undefined (reading 'map')`**
  - Root cause: `validateToolArgs` read `error.errors`, which zod v4 removed in
    favor of `error.issues`. Any failed validation (e.g. a wrong argument key)
    hit `undefined.map`.
  - Now reads `error.issues ?? error.errors ?? []`, so error formatting works on
    both zod v3 and v4 and can never crash on a malformed `ZodError`.
- **`smart_read` now validates its `path` argument**
  - Passing a missing/blank or whitespace-only path (e.g. the wrong key
    `file_path`) returned an opaque downstream error. It now fails fast with
    `smart_read requires a non-empty "path" argument`.

### Tests
- Added regression coverage: `validateToolArgs` formats failures without the
  `.map` crash, and the `smart_read` path guard rejects empty/whitespace/
  non-string paths.

### Docs
- Rewrote `docs/TESTING_INSTRUCTIONS.md` for the WSL2/Linux native port:
  correct `path` argument, daemon/`invoke-mcp.js` invocation, WSL paths
  (`dispatcher.log`, `~/.token-optimizer-cache/cache.db`), the dedup-based
  Read interception model, and a regression test for the `.map` crash.

## [2.20.0] - 2025-10-30

### Fixed
- **Fixed flaky performance tests in CI/CD pipeline**
  - Increased timeout from 200ms to 500ms in path-traversal.test.ts
  - Accounts for CI environment variability
  - Prevents intermittent release workflow failures
  - All performance benchmarks now stable across all Node.js versions

### Changed
- **Complete repository cleanup and organization**
  - Removed 75+ junk files (archive/, AGENT_*.md, *REPORT.md, fix scripts)
  - Moved 13 documentation files to docs/ folder for better organization
  - Moved utility files to proper locations (scripts/, examples/)
  - Removed duplicate documentation files
  - Clean, professional root directory structure

### Security
- **Removed committed secrets from repository**
  - Deleted .mcpregistry_registry_token (contained JWT token)
  - Enhanced .gitignore to prevent re-adding token files
  - Added comprehensive patterns for secrets and temporary files

### Improved
- **Enhanced .gitignore patterns**
  - Comprehensive patterns per CLAUDE.md policies
  - Prevents report/investigation files
  - Blocks temporary scripts and lock files
  - Excludes worktrees and ${HOME}/ artifacts

## [2.4.0] - 2025-10-20

### Fixed
- **CRITICAL: Enabled actual token savings by leveraging smart_read MCP tool's built-in caching**
  - **Previous implementation (v2.4.0-beta)** tried to manually manage cache via hooks but conflicted with user enforcers
  - **Root cause**: Redundant caching layers - hooks duplicated what smart_read already provides
  - **Correct architecture**: Use smart_read MCP tool in PreToolUse hook instead of plain Read
  - smart_read has sophisticated built-in caching with SQLite persistence, diffing, and truncation
  - All Read operations now automatically leverage smart_read's cache-aware intelligence
  - Removed redundant `Handle-CacheRetrieval` and `Handle-AutoCache` functions
  - Added `Handle-SmartRead` that calls smart_read MCP tool directly
  - Runs BEFORE user enforcers to ensure caching takes priority
  - Enables both multi-read savings (same session) and cross-session savings (SQLite persistence)

### Added
- `Handle-SmartRead` function in token-optimizer-orchestrator.ps1 (PreToolUse phase)
- `smart-read` action in orchestrator switch statement
- Comprehensive logging for cache hits/misses, diffs, and token savings
- PreToolUse smart_read intercept in dispatcher.ps1 for all Read operations
- Graceful fallback to plain Read if smart_read fails

### Technical Details
- **smart_read MCP tool** (src/tools/file-operations/smart-read.ts):
  - Built-in CacheEngine with SQLite persistence + in-memory LRU cache
  - Automatic cache key generation based on file path and options
  - Gzip compression for cached content
  - Diff mode: Returns only changes if file was previously read
  - Truncation: Intelligently limits large files to maxSize (default 100KB)
  - Chunking: Breaks very large files into manageable pieces
- **Hook architecture**:
  - PreToolUse: Calls smart_read instead of allowing plain Read
  - If smart_read succeeds: Blocks plain Read and returns cached/optimized content
  - If smart_read fails: Falls back to plain Read gracefully
  - No PostToolUse caching needed - smart_read handles it internally
- **Cache keys**: Use absolute file paths for cross-session persistence
- **Token savings**:
  - Cache hit: Returns compressed content (typical 85-95% reduction)
  - Diff mode: Returns only changes (typical 95-99% reduction for minor edits)
  - Truncation: Caps large files at 100KB (configurable)

### Performance Impact
- **Multi-read scenario**: Second read of same file returns cached version (85-95% token savings)
- **Cross-session scenario**: Files cached in session 1 instantly available in session 2
- **Diff scenario**: File re-read after minor edits returns only diff (95-99% token savings)
- **Large files**: Auto-truncated to 100KB max, preventing token overflow
- **Estimated overall reduction**: 70-90% across typical coding sessions

## [2.3.0] - 2025-10-19

### Added
- **CLI Wrapper** (`cli-wrapper.mjs`) - One-shot execution for PowerShell hooks integration
  - Three input modes: stdin (recommended for PowerShell), file, and arguments
  - Zero JSON escaping issues using stdin piping
  - Production-ready error handling and validation
  - Fast execution: <200ms end-to-end
- **PowerShell Hooks Integration** - Complete hooks system in `hooks/` directory
  - `dispatcher.ps1` - Main orchestrator for all hook events
  - `token-optimizer-orchestrator.ps1` - Unified handler for optimization operations
  - `invoke-token-optimizer.ps1` - PowerShell helper using stdin approach
  - `invoke-mcp.ps1` - Generic MCP tool invocation helper
  - Automatic MCP enforcement (blocks git CLI, blocks Read/Grep on code files)
  - Context guard with intelligent optimization triggers
  - Session tracking and analytics
  - Cache warmup and periodic optimization
- **CLI Wrapper Documentation** (`CLI_WRAPPER_README.md`) - Comprehensive usage guide
- **Hooks Documentation** (`hooks/README.md`) - Setup and architecture guide

### Changed
- Package now includes `cli-wrapper.mjs` and `hooks/` directory in distribution
- Updated version from 0.2.0 to 0.3.0

### Technical Details
- Solution for PowerShell-to-Node.js JSON escaping recommended by Google Gemini 2.5 Flash
- Stdin piping avoids all shell escaping issues across Windows/Unix
- Hooks work seamlessly with Claude Code lifecycle events
- Zero manual intervention - fully automated token optimization

## [0.2.0] - 2025-10-19

### Added
- Complete npm package configuration for public publishing
- Comprehensive .npmignore for optimized package size
- Package validation and installation testing scripts
- Pre-publish checklist documentation
- Proper package.json metadata (keywords, author, engines)
- Binary entry point configuration for CLI usage
- Export maps for modern Node.js module resolution

### Changed
- Updated package version from 0.1.0 to 0.2.0
- Changed main entry point to dist/server/index.js (MCP server)
- Updated license from ISC to MIT
- Enhanced build and test scripts for CI/CD compatibility

### Fixed
- Package structure optimized for npm distribution
- Entry point validation and shebang verification

## [0.1.0] - 2025-01-XX

### Added
- Initial release of Token Optimizer MCP
- Core caching engine with SQLite persistence
- Token counting using tiktoken (GPT-4 tokenizer)
- Brotli compression for optimal token efficiency
- MCP server implementation with stdio transport
- Dashboard monitoring and visualization tools
- Intelligent caching strategies (predictive cache, cache warmup)
- Session log parsing and analysis
- Project-wide token optimization analysis
- Metrics collection and reporting
- Advanced file operations with caching
- Build system integration tools
- Code analysis and intelligence tools
- Smart output formatting with compression
- System operations with intelligent scheduling

### Core Features
- optimize_text - Compress and cache text to reduce token usage
- get_cached - Retrieve previously cached and optimized text
- count_tokens - Count tokens in text using tiktoken
- compress_text - Compress text using Brotli compression
- decompress_text - Decompress base64-encoded Brotli-compressed text
- get_cache_stats - Get cache statistics including hit rate and compression ratio
- clear_cache - Clear all cached data
- analyze_optimization - Analyze text and get optimization recommendations

### Technical Stack
- Node.js 18+ runtime
- TypeScript for type safety
- SQLite (better-sqlite3) for persistent storage
- tiktoken for accurate token counting
- Brotli compression (built-in)
- LRU caching for in-memory optimization
- MCP SDK for protocol implementation

[0.2.0]: https://github.com/ooples/token-optimizer-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ooples/token-optimizer-mcp/releases/tag/v0.1.0
