# Mac, gateway and media migration manifest

Source: `cherthq/apple-teams` commit `be47b11fe1317c4747db4121bec37896998b5201`.
Only tracked source, documentation, build recipes and tests were copied; no runtime data.

| Source                                              | ClawdTime destination                             | Source SHA-256                                                     |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `devices/.gitignore`                                | `mac/.gitignore`                                  | `6f05fa84d8a51760e114dce1e1a76b7106dc82d664c8603b7e61f2dfcbb71297` |
| `devices/Package.swift`                             | `mac/Package.swift`                               | `ddc0d9d19c7fe0101806074cbf9626566fa2e55989fd364d8d146b0a275d1f74` |
| `devices/README.md`                                 | `mac/README.md`                                   | `941c31c87d5353fc81b1b579a4ac2dda35959808bf3c6820e717350b4eaff330` |
| `devices/Sources/AppleTeamsDevice/App.swift`        | `mac/Sources/ClawdTimeCompanion/App.swift`        | `14149ceeba3b9c1da7d4373dd6634828be4f99e2718f49ccc31192ea2c952c35` |
| `devices/Sources/AppleTeamsDevice/Capture.swift`    | `mac/Sources/ClawdTimeCompanion/Capture.swift`    | `8158f10a584dc859e1a86fd35806638cc40173d550fab21c48ce172f74083dbd` |
| `devices/Sources/AppleTeamsDevice/HTTPServer.swift` | `mac/Sources/ClawdTimeCompanion/HTTPServer.swift` | `10de5bcfe85e972803656c4341698822d33fef55e4809845f619f5fa6e091efe` |
| `devices/Sources/AppleTeamsDevice/Setup.swift`      | `mac/Sources/ClawdTimeCompanion/Setup.swift`      | `44618539c190cb7e0c6fb6413b197da759e8157032a01f8d7628c50201273023` |
| `devices/Sources/DeviceCore/HTTP.swift`             | `mac/Sources/DeviceCore/HTTP.swift`               | `fd9db06bb8ceef3eebf0ab4ccbd98b6006097f5f4c3cb5f1185c7b2a5cb383de` |
| `devices/Sources/DeviceCore/Policy.swift`           | `mac/Sources/DeviceCore/Policy.swift`             | `e1734fcd1fa942dbef3dc53270108f151f5430735bdfb52c5dac5d751ee0b1ca` |
| `devices/Sources/DeviceCore/ReceiptStore.swift`     | `mac/Sources/DeviceCore/ReceiptStore.swift`       | `677d7051821404bc7b69f0967eae87eda7ae9beba804e4048cb4547bf46f616f` |
| `devices/Tests/DeviceCoreTests/PolicyTests.swift`   | `mac/Tests/DeviceCoreTests/PolicyTests.swift`     | `d0f743ee1d1f40191bbeac7bd55f7e993c85306cd2b771f2553f04107bd4104f` |
| `devices/scripts/package.sh`                        | `mac/scripts/package.sh`                          | `27c49b395e9763579fc4cc41efa0459041554c2fbec06596c2ec6eca570347dc` |
| `gateway/.env.example`                              | `gateway/.env.example`                            | `c4012885eecb1e50e7aa54597bc889701a1b50936907d82dd354788799c2f824` |
| `gateway/Dockerfile`                                | `gateway/Dockerfile`                              | `72ef8601ae4bdc457f3851662d6560efd112aa7ce2f0e2380c1263c5dd63567f` |
| `gateway/README.md`                                 | `gateway/README.md`                               | `e6a44e417324dae7f6e94aba317e45e199d25afea3c7cdcebc411b4829e65c57` |
| `gateway/relay.py`                                  | `gateway/relay.py`                                | `92ad24095a1e3822ea0460604bc8316e600b35ffdf9049201ed77bdd0adbf256` |
| `gateway/requirements.txt`                          | `gateway/requirements.txt`                        | `9ff2177e763edd4e9724ffbd5a78794aa24e8492245e2f9e2b3f521fdf956b74` |
| `gateway/service.py`                                | `gateway/service.py`                              | `97b84b0a00fc926b9caefa7489fc6a7f18d41c26d28b9711925d5510e4810be9` |
| `gateway/test_device_contract_review.py`            | `gateway/test_device_contract_review.py`          | `fe25f77828bcd01e02267ee925682b794d54a2943119f69da3b5d3080641bf67` |
| `gateway/test_gateway.py`                           | `gateway/test_gateway.py`                         | `21a47adacc36340a7dff87bec98dfdbd7061ebad4d404e6f28786c23796607f8` |
| `media/.dockerignore`                               | `media/.dockerignore`                             | `8f2de89ab06995be43ada0dd1d575cacd632630ee0abef80cca948299822954f` |
| `media/.env.example`                                | `media/.env.example`                              | `e6734d0092770d14a1fc4c92b1c02a3842f93d04de11bcb3570154dcc0f39820` |
| `media/Dockerfile`                                  | `media/Dockerfile`                                | `6447e7132de83a1eff56e853c8fe563a35f0d9bf71655acb86951d2eba6eac4d` |
| `media/captions.py`                                 | `media/captions.py`                               | `f3eef2c1b456f0e099d499b4718e3efa689e9436673d51cc738f1370e30cfc44` |
| `media/device_actions.py`                           | `media/device_actions.py`                         | `82ee1a4fc68a11fe00f3ff78097d4253e230f02d82b7e38d57159dd5c2dabbf8` |
| `media/device_relay.py`                             | `media/device_relay.py`                           | `8ff415334314b4202c57e5d89a3758dae4d512adcfc52d71efe2a330d22a45fe` |
| `media/devices.py`                                  | `media/devices.py`                                | `8348bfd9cdfa98fa041190541d5863b3d74be0919faf169b6af9101403a5c734` |
| `media/ledger_backup.py`                            | `media/ledger_backup.py`                          | `0e411fde0b22e8e9731ad12bc73f355dff47c0ea7d46b942967bc8ed27d3e3e3` |
| `media/playback.py`                                 | `media/playback.py`                               | `c06711f6334c6598618a3430f3f75166bb13eac211fac4fb97552e56cdc06695` |
| `media/policy.py`                                   | `media/policy.py`                                 | `ee4442aafd841ec64ecfdb3f3ef59c2f05fd013c6b290bb27bd647099b709fda` |
| `media/requirements.txt`                            | `media/requirements.txt`                          | `a01fd5416cee843d3c1c978b16b97a32b10ba9d26137f9e3fc609135c717b0b9` |
| `media/server.py`                                   | `media/server.py`                                 | `ef034512b93a590610afa4acb596d0e5c3eb44ac34466135ce73e7e8997ea845` |
| `media/smoke.py`                                    | `media/smoke.py`                                  | `892158224002fe61cce0e90721013fcff78988d998b448a2f38d9db6d2988077` |
| `media/test_caption_service.py`                     | `media/test_caption_service.py`                   | `207ec5ec4bc4c8cde8fd5a70704be6241357a12b2eda2cf5b8976126c09c2a72` |
| `media/test_captions.py`                            | `media/test_captions.py`                          | `12198f304437b2e4ededf600cd5027157508d3851c1d0f0bd2683c66bafcf681` |
| `media/test_devices.py`                             | `media/test_devices.py`                           | `82ea76974b776fac935a513896b31f8792260f5353279ca3a67d0b0562fd165b` |
| `media/test_ledger_backup.py`                       | `media/test_ledger_backup.py`                     | `a218ee5e8ba0278c2554a557407dc91e51658b6da7ee9e6803481529edcaba8d` |
| `media/test_playback.py`                            | `media/test_playback.py`                          | `6028322b804b1af33e62d44576392f31d1ff23b6e3a77ad01474542fba237dfd` |
| `media/test_policy.py`                              | `media/test_policy.py`                            | `901e34cfdcbdd8ef5b4e68bc8855c8f3728b4ac6c38b001dd64ff8830e24b971` |
| `media/test_service.py`                             | `media/test_service.py`                           | `7f5a73748812bf13519aca007db738778e370b6a8a256e0793ecf7ee9726abd7` |

## Explicit changes

Application branding, macOS bundle/executable/storage namespace, ports (4212 media, 4213 helper, 4214 gateway), media room/track namespaces, and media session prefix (`ct_` instead of `at_`) are independent. Media backup magic is `CTMED001` with `clawdtime-media-ledger-v1` identity; Apple Teams ledgers are deliberately incompatible and are never imported. Shared helper/gateway wire fields and receipt fingerprint formats remain unchanged. `meetingId` is retained as a media wire field and carries the ClawdTime attention request ID; no meeting/workspace engine is imported.

Matching retained tests run against the migrated code; their results are recorded independently. Further integration changes include ClawdTime attention consent wording, qualified speech metadata, lifecycle control and installer convenience.

## Protocol-2 release preparation

Deploying this source requires coordinated backend/media/gateway/companion versions;
old helpers do not advertise revisioned local policy and cannot qualify protocol-2
execution. A new helper defaults to Agent tools only even for old controller ACLs.
Users must deliberately choose fallback locally; preserve both the old action ledger
and the new private `control-policy.json`. Never copy runtime screens/audio or reset
unknown receipts to force migration. Old sessions keep their negotiated protocol.

No production service, gateway, installed companion or call was started by this
implementation. Installing/restarting the companion requires separate approval and
must preserve its stable signing identity and existing macOS permissions. Rollback
stops sharing and reconciles active/unknown inputs before replacing source; retained
receipts and policy revisions are never deleted. Mixed-version fallback is refused.
