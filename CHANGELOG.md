# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
