# Turfwar: Game Plan & Tech Stack

*Draft v0.4, 2026-10-09. A just-for-fun project: get it playable quickly, and only build for scale if it takes off. Items marked **OPEN** need a design decision. Decisions are logged in §12. The earlier, heavier plan (own capture, Gaussian splats, voxel world, Rust servers) is in git history at commit `d42c1f2`.*

---

## 1. The pitch

Turfwar is an always-online, browser-based FPS played in your real hometown. The world is **Google Photorealistic 3D Tiles**: real streets and buildings, streamed live. Players sign up with email and join the faction that controls the ground where they actually live. They then fight a persistent war over real city blocks, leaving craters that stay. Factions' territory grows and shrinks organically, depending on where their members survive and where they die. Bots garrison every faction's ground, so the world never feels empty.

The launch area is Glendale, CA, around Alexander St (§5).

---

## 2. Key decisions

1. **The world is Google Photorealistic 3D Tiles, streamed live and never stored.**
   - Clients render the tiles.
   - The server streams the same tiles and builds collision from them in memory.
   - Nothing from Google is written to disk.
2. **Destruction is our own data layered on top.** A crater is a small record: position, radius, time. Craters are applied at runtime to both the visuals and the collision. Crater records are the only world data we store.
3. **Territory is a living "safety field".** It grows where a faction's members spend time without dying and shrinks where they die (§4.5).
4. **TypeScript everywhere, one server.** Client and server share the movement, collision and crater code. One small server process runs the whole game until there's a reason to scale.
5. **Fun first.** Accept the tiles' street-level look, hollow buildings and Google's updates as tradeoffs. Fix things only when they hurt the fun.

---

## 3. What we accept by using Google tiles

| Tradeoff | Why it's OK for now |
|---|---|
| The tiles come from aerial photos, so they look great from rooftops but "melty" at street level (blobby trees and cars, missing overhangs) | No affordable alternative covers the whole world beautifully. Coverage beats polish for a fun project |
| Buildings are hollow shells, with no interiors or floors | A blast hole shows a dark interior. A free elevation model (DEM) under everything stops players falling into the void (§6.3) |
| No materials: ground, buildings, trees and cars are one continuous surface | Every surface reacts the same to explosions. Material detection is overkill for now |
| Google updates tiles, and you can't pin a version | Craters are spheres in world space, so they keep cutting whatever geometry is there after an update |
| Cost | 1,000 sessions a month are free, then about $6 per 1,000. A session is one player (or the server) streaming for up to 3 hours, so a small group of friends costs roughly nothing |

---

## 4. Game design

### 4.1 World structure

| Layer | What it is |
|---|---|
| **The Front** | The persistent, always-on war (Command & Conquer). It runs as one or more **worlds** |
| **Arenas** | FFA and TDM matches in a bounded area of the real map (e.g. "TDM: 400 m around Alexander St") |

### 4.2 Worlds and destruction rules

**The Front runs as worlds**, like MMO realms or survival-game servers. Each world has its own factions, territory and craters. Players pick a world, and faction membership is per world.

Each world's destruction rule is set by the server:

| World type | Destruction |
|---|---|
| **Permanent** | Craters never heal. Contested frontlines turn into crater-filled, smoking hellscapes (§6.4) |
| **Regrowing** | Craters fade out over a set half-life (e.g. 6 h or 3 days) |

Launch with one Permanent world. Add a Regrowing world once there are enough players to fill two.

**Arenas** set destruction per playlist:

| Playlist | Destruction |
|---|---|
| FFA / TDM "Classic" | Off |
| FFA / TDM "Wrecking" | On; resets when the match ends; craters regrow over 2–5 min |

### 4.3 FFA & TDM
These follow the standard formats: 8–16 players for FFA, up to 16v16 for TDM, with a score or time limit. Spawn points are scored by distance from enemies and line of sight to them. Bots backfill empty slots.

### 4.4 Factions: your real location decides
- **Joining.** When you first enter a world, the browser asks for your location. You join whichever faction's territory contains that point.
- **Unclaimed ground.** If the point is unclaimed, you found a new faction there. **OPEN:** or join the nearest faction within some distance?
- **Splinter factions.** Members of an existing faction can deliberately break away together to form a new one. This needs a minimum group (e.g. 3+ members), and they found it the same way as a displaced faction (§4.6).
- **Staying put.** Your faction is locked once you join. Relocating is allowed after a long cooldown. **OPEN:** cooldown length.
- **Where the world is.** Google tiles cover most cities, so data no longer limits where people can play. Player density does: with a global world, most players would be alone with bots. **OPEN:** start The Front bounded to Glendale (out-of-area players assigned to the faction with the fewest active members), or open it everywhere?
- **Location accuracy and cheating.**
  - Desktop browsers locate you by Wi-Fi or IP, so the player confirms the detected point on a map.
  - Only a coarse home area (~1 km²) is stored.
  - Faking a location in a browser is easy, so cross-check it against IP geolocation and lock the faction once assigned.

### 4.5 Territory: the safety field
The ground is divided into 8 m × 8 m patches. Every faction has a **safety** value `S` on every patch. Once a second, the server updates each faction's field:

```
for each faction f, patch p:
  S[f][p] *= decay                                     # fades slowly when nobody from f is around
  S[f][p] += spread * (avg_of_neighbours - S[f][p])    # bleeds outward, which makes organic edges
  S[f][p] += presence_gain   per active human member of f near p
  S[f][p] -= death_penalty   (falling off over radius r) where a member of f dies

owner(p) = the faction with the highest S,
           if that S is above threshold T and leads the runner-up by margin M
           (otherwise the patch is unclaimed)
```

**What this produces**
- Territory is a soft blob that grows where a faction's people spend time without dying and erodes where they keep dying.
- An enemy who survives inside your ground builds their own safety there and can eventually overtake yours.
- Where two factions' fields are nearly equal, neither wins by margin `M`. A strip of unclaimed no-man's-land appears between them on its own.

**Rules that keep it honest**
- **Only humans move the field.** Bots add nothing, and their deaths subtract nothing. Bots do kill intruders, and an intruder's death counts against *their* faction. That's how garrisons defend without capturing.
- **Only active players count.** Each player's contribution is capped, and many members stacked in one spot get diminishing returns, so standing in a corner can't farm territory.
- **Decay is slow** (half-life of days), so territory is lost mainly by dying, not by logging off. **OPEN:** exact value.

**Tuning.** The knobs are decay, spread, presence gain, death penalty and its radius, `T` and `M`. Tune them with a quick 2D simulator with fake players (step 4 in §11) before the full game exists.

### 4.6 Contested ground, spawning and displacement
- **Contested.** A patch is contested for your faction if one of your members died within radius `r` in the last `N` minutes, or an enemy human is within `r` right now.
- **Spawning.** You can only spawn on patches your faction owns that aren't contested, preferring the safest patches. If every owned patch is contested, nobody in the faction can spawn until things calm down. **OPEN:** whether an HQ is an exception.
- **Displaced.** A faction that owns no ground must re-found on unclaimed ground at least `D` km from any faction. A protection window (e.g. 30 min in which deaths there don't count) lets it grow a foothold before fighting back.
- **Strategic map.** A top-down camera over the same Google tiles, with the safety fields drawn on top as soft, glowing blobs. Recent deaths pulse, contested ground shows red hatching, and squad positions are marked. The map uses Google's tiles rather than OSM because of a Google rule (§7).

### 4.7 Bots: faction garrisons
- **Every faction's territory is garrisoned by its bots.** Garrison bots are friendly to the owner and hostile to everyone else who enters. Unclaimed land has no bots.
- **Bots never capture** (§4.5).
- **Bots only exist near humans.** They spawn within ~150–300 m of a human and despawn when none is near. That saves server CPU and avoids endless bot-vs-bot wars on empty borders.
- **Bot weapons do little terrain damage**, so the hellscape is made by players. **OPEN.**
- **Labeling.** Bots are labeled as bots.
- **In Arenas,** bots backfill to a minimum headcount.

### 4.8 Accounts
Players sign up by email with a 6-digit code, then choose a display name. The location prompt comes when they first join a world.

---

## 5. Launch area: Glendale, CA

**Center:** Alexander St, Glendale City Center, 91203, at roughly 34.153° N, 118.267° W. Start with a ~1 km × 1 km play area.

| Feature | Where | Game meaning |
|---|---|---|
| Ventura Freeway (CA-134) | Just north of Alexander St | A natural frontline with overpass and underpass chokepoints |
| San Fernando Rd (rail and industrial corridor) | Southwest edge | Warehouses and long sightlines |
| Brand Blvd high-rises | ~1.1 km east | **OPEN:** stretch the play area east to include them |
| Every building, school and church | Everywhere | Treated the same: craters cut everything |
| **One protected house** | Inside the area | Can't be damaged. Craters are clipped against the house's OSM footprint (§6.2). The footprint ID lives in a private config, not in this doc |

---

## 6. The world: Google tiles plus our craters

### 6.1 Rendering (client)
- **Renderer:** three.js with `3d-tiles-renderer` (NASA-AMMOS/3DTilesRendererJS).
- **Google access:** its `GoogleCloudAuthPlugin` handles the API key, session tokens and attribution.
- **Local coordinates:** its re-centering plugin (`ReorientationPlugin`) puts Alexander St at the origin with Y up, giving a flat local frame in meters.
- **Detail level:** a low error target near the player, so street-level tiles load at full detail.
- **Material hook:** every tile's material goes through one hook on load, which adds the crater cut (§6.2).

### 6.2 Craters on a hollow-shell world
A crater record is `{world, id, x, y, z, radius, created_at, cause}` in the local frame. The server stores it, and every client receives it.

**Visuals (client)**
- **Cutting.** The tile shader discards any pixel inside a crater sphere. Craters are bucketed into a small grid texture, so each pixel only tests the craters near it.
- **Ground hits.** A ground crater draws the lower half of its sphere from the inside, using a dirt and ash material, so it reads as a bowl.
- **Wall hits.** A hole in a wall reveals the building's inside faces. Tile back faces render as dark "interior" instead of being culled, so you see a dark gap rather than a see-through hole.
- **Dressing.** Scorch decals around the rim, rubble props, smoke and embers.
- **The protected house.** Its OSM footprint, extruded upward, is a no-cut zone: crater tests skip pixels inside it, and the server's collision does the same. The footprint is our open data; we never detect objects in Google's tiles.

**Collision (server, and client for prediction)**
- **Tile collision.** A BVH (`three-mesh-bvh`) is built over the tile triangles near players, in memory only.
- **Holes.** Collision and raycast tests ignore any surface inside a crater sphere.
- **Bowls.** A ground crater adds its bowl as a walkable surface.
- **Rays.** Bullets pass through crater holes.

### 6.3 Safety-net floor
Google's buildings have no floors, so walking into a blasted building would drop you forever.
- A free 1 m elevation model (USGS 3DEP DEM in the US; Copernicus 30 m elsewhere) sits slightly below the visible ground as a backstop floor.
- Crater bowls carve into it.
- A fixed depth limit (~10 m) acts as bedrock.
- The DEM is open data, so it can be stored and shipped.

### 6.4 Permanent worlds: the hellscape
- **Craters pile up.** Overlapping bowls form rolling crater fields. The depth limit keeps them climbable.
- **Scarring layer.** The server keeps a coarse heat map of crater density and age per area. Clients turn it into smoke columns, embers, ash and haze, so frontlines are visible from a distance and on the strategic map.
- **Bounded data.** Crater records are tiny. Merge overlapping old craters into one larger record to keep the count bounded.
- **The protected house** will stand untouched in the middle of the crater field. Expect it to be the most fought-over spot on the map.
- **OPEN:** does "permanent" mean forever, or until a season reset?

### 6.5 How the server gets geometry
- **Streaming.** The server runs `3d-tiles-renderer`'s tile traversal headless in Node, with a virtual camera at each active player. It loads the same full-detail tiles the clients see nearby.
- **Geometry only.** Textures are skipped, which keeps memory small.
- **Collision.** It builds the BVH from the tiles in memory.
- **Lifetime.** Tiles are evicted when no player is near, honoring Google's cache headers. Nothing is written to disk.
- **First step:** the step 2 test in §11 proves this works.

---

## 7. Staying inside Google's rules

| Rule | What we do |
|---|---|
| Show attribution | The Google logo and the tiles' copyright text are always on screen, in game and on the map |
| No pre-fetching, storing or caching beyond the allowed conditions; no offline use | Tiles and anything built from them live in memory only and are evicted per cache headers. We store only crater records, the field and the DEM, which are all our own or open data |
| No geodata extraction, no object detection | We never export geometry and never classify Google content. The protected house uses its OSM footprint |
| No Google content alongside non-Google maps | The strategic map is a top-down view of Google tiles, not an OSM basemap |
| Protect the API keys | The client key is restricted to our domain and the Map Tiles API. The server key is restricted to the server's IP. Budget alerts and quotas are set in Google Cloud |

**Gray areas, honestly.** Collision built on a server (rather than a player's display) and cutting holes in Google's rendered surfaces aren't explicitly allowed or forbidden. Runtime collision on these tiles is common practice: Cesium for Unreal does it by default, including on dedicated servers. For a private, just-for-fun project, the realistic worst case is Google disabling the API key. If this ever goes public or commercial, get the Maps Platform terms reviewed. This isn't legal advice.

---

## 8. Tech stack (quick version)

| Part | Choice |
|---|---|
| Language | TypeScript everywhere, in an npm workspaces monorepo |
| Client | Vite + three.js + `3d-tiles-renderer` + `three-mesh-bvh`. Pointer Lock for mouse look. HTML overlay for HUD and menus |
| Shared code | Movement, collision queries, crater math, safety-field sim. The same code runs in client prediction and on the server |
| Server | Node (or Bun): game loop at 30 Hz, WebSockets (`ws`), headless tile streaming + BVH (§6.5), bots, safety field |
| Netcode | Server-authoritative. The client predicts its own movement and reconciles; other players are interpolated ~100 ms behind; the server rewinds ~200 ms for hitscan. WebSockets keep it simple; switch to WebTransport (supported in all major browsers since March 2026) if lag ever matters |
| Database & auth | Supabase (free tier): Postgres for users, worlds, factions, craters and field snapshots, plus email one-time-code sign-in. Add Resend as the email sender if Supabase's built-in email limits bite |
| Hosting | Client on Cloudflare Pages (free). Server on one small VPS in the US West (~$10–20/month) |
| Google | Map Tiles API: two restricted keys, budget alerts |
| Monthly cost | ~$10–25 while it's friends-scale |

### 8.1 Bots
- **Same inputs as players.** Bots run inside the server and send the same input commands players do, through the same movement code.
- **Navigation.**
  - Around each human, the server samples a ~1 m walkability grid by casting rays down onto the in-memory collision.
  - It re-samples wherever new craters land, and pathfinds with A* on the grid.
  - The grid is thrown away when no human is near.
- **Behavior.** A simple state machine: patrol, engage, take cover, fall back.
- **Aim.** Humanized: reaction delay and tracking error. Bots only shoot at what they can see.

### 8.2 Data model
```
users            (id, email, display_name, created_at)
worlds           (id, name, destruction: permanent|regrowing, regen_half_life)
factions         (id, world_id, name, color, status: active|displaced, founded_at, parent_faction_id NULL)
faction_members  (world_id, user_id, faction_id, joined_at, home_area, relocate_after)
craters          (world_id, id, x, y, z, radius, created_at, cause)
field_tiles      (world_id, faction_id, tile_x, tile_y, updated_at, data bytea)
deaths           (world_id, at, x, y, victim_faction, killer_kind: human|bot)
```

---

## 9. Repository layout

```
turfwar/
  client/      Vite + three.js app (tiles, FPS controls, HUD, strategic map)
  server/      Node game server (loop, websockets, tile streaming, bots, field)
  shared/      movement, collision, crater math, safety-field sim, protocol types
  tools/       fieldsim (2D territory tuner), dev scripts
  PLAN.md
```

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Running the tile loader headless in Node is harder than expected | Step 2 in §11 proves it first. Fallback: fetch and decode the glTF tiles directly in Node |
| Client and server load slightly different tiles, so collision disagrees | Both use full detail near players; the server is authoritative; prediction corrections are small |
| Melty street-level geometry (blob trees you can stand on, bumpy ground) | Character controller with step-up and slope limits; accept the rest |
| Hollow buildings feel odd once you're inside | Dark interiors and the DEM floor. Later: simple procedural floors |
| Google disables the key or changes pricing | Stay inside the rules in §7, with budget alerts. The heavier own-data plan in commit `d42c1f2` is the fallback |
| API key stolen from the client and abused | Domain restriction, quotas, budget alerts |
| Too few players for a persistent world | Bots, Arenas, and a bounded launch area |

---

## 11. Build steps

| Step | Goal | Done when |
|---|---|---|
| 1 | **Walk around Alexander St** | Google tiles render in three.js at street level with FPS controls, attribution and capsule collision on the loaded tiles |
| 2 | **Server sees the same world** | A Node server streams the same tiles headless and builds collision; a ray fired on the server hits the same wall as on the client |
| 3 | **Multiplayer + shooting** | Two players move and shoot over WebSockets with prediction, interpolation and server-side hits |
| 4 | **Craters** | A grenade cuts a visible hole and bowl, players can walk into it, bullets pass through holes, craters survive a server restart, and the protected house can't be cut |
| 5 | **Territory sim** | A 2D tuner page shows the safety field behaving well with fake players |
| 6 | **The Front v1** | Email login, location-based factions, the safety field live in game, spawn rules, the strategic map |
| 7 | **Bots + hellscape** | Garrison bots, smoke and scarring, Arenas (FFA/TDM) |

### If it takes off
Revisit the heavier plan in commit `d42c1f2`:
- photoreal street-level capture with Gaussian splats
- a real voxel world for richer destruction
- a Rust server
- WebTransport
- multiple servers per world

---

## 12. Decision log

| Date | Decision |
|---|---|
| 2026-10-09 | You join the faction whose territory contains your real location. Splinter factions can form from existing members |
| 2026-10-09 | Territory is an organic area based on relative safety (the safety field) |
| 2026-10-09 | Bots garrison all owned territory: friendly to the owner, hostile to everyone else. They never capture |
| 2026-10-09 | Destruction is permanent or regrowing per server (world). Permanent worlds become hellscapes, which is intended |
| 2026-10-09 | Launch area: Glendale, CA, around Alexander St (91203) |
| 2026-10-09 | No exclusion zones; one protected house can't be destroyed (footprint ID in private config) |
| 2026-10-09 | **World = Google Photorealistic 3D Tiles**, streamed live, never stored; collision built in memory; craters stored as our own data. *Supersedes the own-capture / splat / voxel plan (commit `d42c1f2`).* |
| 2026-10-09 | Just-for-fun scope: TypeScript everywhere, one server, WebSockets, Supabase |

---

## 13. Open questions

1. **World extent.** Is The Front bounded to Glendale at first, or open everywhere?
2. **Unclaimed home location.** Found a new faction there, or join the nearest one?
3. **Splinters.** Minimum group size? Cooldown between splits?
4. **Field tuning.** Decay half-life, death penalty radius, how long ground stays contested.
5. **No spawnable ground.** If all owned ground is contested, can a faction spawn at an HQ?
6. **Garrison bots.** Denser at borders or in the core? Can they use explosives?
7. **Permanent worlds.** Forever, or seasons with a reset?
8. **Play area.** Stretch east to include the Brand Blvd towers?

---

## References

- 3DTilesRendererJS (three.js 3D Tiles + Google plugins): https://github.com/NASA-AMMOS/3DTilesRendererJS
- three-mesh-bvh: https://github.com/gkjohnson/three-mesh-bvh
- Map Tiles API policies: https://developers.google.com/maps/documentation/tile/policies
- Map Tiles API usage and billing: https://developers.google.com/maps/documentation/tile/usage-and-billing
- Google Maps Platform terms ("No Use With Non-Google Maps"): https://cloud.google.com/maps-platform/terms
- Cesium for Unreal, Google tiles collision on a dedicated server: https://community.cesium.com/t/generating-cesium3dtileset-collision-on-a-dedicated-unreal-server/46557
- Cesium for Unreal, Google tiles physics meshes: https://community.cesium.com/t/google-photorealistic-3d-tiles-turn-off-collision/30351
- WebTransport reaches Baseline: https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/
