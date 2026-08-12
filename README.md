# minecraft-protocol-forge
[![NPM version](https://img.shields.io/npm/v/minecraft-protocol-forge.svg)](http://npmjs.com/package/minecraft-protocol-forge)
[![Join the chat at https://gitter.im/PrismarineJS/node-minecraft-protocol](https://img.shields.io/badge/gitter-join%20chat-brightgreen.svg)](https://gitter.im/PrismarineJS/node-minecraft-protocol)

Adds FML/Forge support to [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) (requires 0.17+)

## Features

* Supports the `FML|HS` client handshake
* Adds automatic Forge mod detection to node-minecraft-protocol's auto-versioning

## Usage

Installable as a plugin for use with node-minecraft-protocol:

```javascript
var mc = require('minecraft-protocol');
var forgeHandshake = require('minecraft-protocol-forge').forgeHandshake;
var client = mc.createClient({
    host: host,
    port: port,
    username: username,
    password: password
});

forgeHandshake(client, {forgeMods: [
  { modid: 'mcp', version: '9.18' },
  { modid: 'FML', version: '8.0.99.99' },
  { modid: 'Forge', version: '11.15.0.1715' },
  { modid: 'IronChest', version: '6.0.121.768' }
]});
```

The `forgeMods` option is an array of modification identifiers and versions to present
to the server. Servers will kick the client if they do not have the required mods.

To automatically present the list of mods offered by the server, the `autoVersionForge`
plugin for node-minecraft-protocol's `autoVersion` (activated by `version: false`) can
be used:

```javascript
var mc = require('minecraft-protocol');
var autoVersionForge = require('minecraft-protocol-forge').autoVersionForge;
var client = mc.createClient({
    version: false,
    host: host,
    port: port,
    username: username,
    password: password
});

autoVersionForge(client);
```

This will automatically install the `forgeHandshake` plugin, with the appropriate mods,
if the server advertises itself as Forge/FML. Useful for connecting to servers you don't
know if they are Forge or not, or what mods they are using.

## Modded login sub-protocols and local jar derivation

Many mods (and, through Sinytra Connector, Fabric mods) run their own login
sub-protocols during the Forge handshake — owo-lib channel/controller
fingerprints, and per-mod `SimpleChannel` login "Acknowledge" messages
(TACZ, MrCrayfish Framework, …). Their required replies are content
fingerprints of the mod's own code that never cross the wire, so they cannot
be echoed back from what the server sends. To answer them, the handshake
responder can **statically derive the replies from the mod jars in the
player's local instance `mods/` folder**, supplied via the `modsPaths` option
(a jar file, a directory of jars, or an array), or the
`MINEPAL_FORGE_MODS_DIR` environment variable:

```javascript
autoVersionForge(client, { modsPaths: ['/path/to/instance/mods'] });
```

Resolution order for a wrapped login channel is: a hand-verified protocol
table entry first, then the jar-derived `SimpleChannel` login ack
(`loginAckDerivation.js`), then the generic FML acknowledge. owo handshakes
derive their required fingerprints from the same folder.

**What the derivation reads, and what it does not.** It reads the mod `.jar`
files on the local machine and statically parses their bytecode to extract
only how each mod registers its network channels (channel ids, message
registration indices, particle-system counts) — the signatures needed to
complete the server's mod handshake. It runs entirely on the local machine:
the mod list is never uploaded anywhere, and mod code is never classloaded or
executed — the jars are read and parsed, never run. (Enforced by
`test/privacyLaws.test.js`.)

### Modded block shapes (`blockShapeDerivation.js`)

The same local jars also answer a perception question the wire protocol
cannot: **which modded blocks have no collision** (plants, crops, signs) and
**how many block states each one registers**, so a modless client can resolve
modded palette ids to passable blocks instead of treating every modded block
as a solid cube. `deriveBlockShapes(jarPaths)` statically extracts, per
registered block: the registry name, the block class's superclass chain, its
`BlockBehaviour.Properties` no-collision evidence (`noCollission()` /
`copy()` of a provably no-collision vanilla block), and its state-definition
property product. All vocabulary is mapping-level (generated from the real
deobfuscated vanilla jar and published SRG/intermediary mappings by
`tools/genBlockShapeTables.js` — nothing per-mod), and ambiguous or dynamic
evidence always ABSTAINS to the conservative solid interpretation. Besides
direct `DeferredRegister` / Fabric `Registry.register` idioms, the linkage
follows two framework-level registration mechanisms (again by structure,
never by mod identity): Registrate-style fluent builder chains
(`.block(name, factory)…register()`, with `.properties`/`.initialProperties`
evidence and opaque `.transform` abstention) and const-namespace
consumer-helper sinks (a static helper building a `ResourceLocation` from a
constant namespace plus a name parameter). Loop-driven vanilla state
definitions are counted through per-class contribution factors the generator
solves as equations against minecraft-data totals (self-test: every vanilla
block exact). Same privacy laws as above: local-only, read-only, never
executes mod code, output goes only to the embedding client's perception
layer. (Enforced by `test/privacyLaws.test.js`.)

## Installation

`npm install minecraft-protocol-forge`

## Debugging

You can enable some protocol debugging output using `NODE_DEBUG` environment variable:

```bash
NODE_DEBUG="minecraft-protocol-forge" node [...]
```
