"""Region 1 content seed (owner 2026-11-26): area quizzes, daily questions, a few quests.

Every fact comes from the catalog itself: destination -> town -> province (admin_areas),
destination subcategory, and the four provincial capitals. Nothing is invented.

Inputs (exported from a restored copy of the production backup):
  catalog.json   published, non-test spots with town, province, subcategory, photo, quiz/quest flags
  allnames.json  [lower(name), town, province] for all spots (used to avoid ambiguous answers)
Outputs:
  seed.sql       idempotent (ON CONFLICT DO NOTHING); every id starts with seed-r1 / qotd-r1 / -seedr1
  rollback.sql   removes exactly what seed.sql adds (refuses quests/quizzes that already have attempts)

Run: python -I generate.py   (from this folder)
"""
import hashlib
import json
import re
import uuid
from collections import defaultdict

NS = uuid.UUID("6f1d3c2a-8b7e-4f6a-9c1d-2e3f4a5b6c7d")
ADMIN = "5da4fff5-2b2c-4d83-b8b0-bfa545681551"  # owner's platform admin account
PROVINCES = ["Ilocos Norte", "Ilocos Sur", "La Union", "Pangasinan"]
CAPITAL = {"Ilocos Norte": "Laoag City", "Ilocos Sur": "Vigan City", "La Union": "City of San Fernando", "Pangasinan": "Lingayen"}

LABEL = {
    "church": "A church", "heritage_site": "A heritage site", "museum": "A museum",
    "park": "A park", "recreation": "A recreation area", "running_spot": "A running spot",
    "beach": "A beach", "island": "An island", "tidal_pool": "A tidal pool", "water_activity": "A water-activity spot",
    "waterfall": "A waterfall", "river": "A river", "cave": "A cave", "rock_formation": "A rock formation",
    "trailhead": "A trailhead", "viewpoint": "A viewpoint", "scenic_viewpoint": "A viewpoint",
    "market": "A market", "crafts": "A crafts shop", "restaurant": "A restaurant",
    "local_food": "A local food spot", "street_food": "A street food spot",
}
# Labels in the same group could both be "right" (a church is often a heritage site), so
# distractors always come from other groups.
GROUP = {
    "church": "heritage", "heritage_site": "heritage", "museum": "heritage",
    "park": "leisure", "recreation": "leisure", "running_spot": "leisure",
    "beach": "coast", "island": "coast", "tidal_pool": "coast", "water_activity": "coast",
    "waterfall": "nature", "river": "nature", "cave": "nature", "rock_formation": "nature",
    "trailhead": "nature", "viewpoint": "nature", "scenic_viewpoint": "nature",
    "market": "trade", "crafts": "trade", "restaurant": "trade", "local_food": "trade", "street_food": "trade",
}
# A distractor is dropped when the place's own name hints at it (e.g. "Maranum Falls & Sky Plaza").
GROUP_KEYWORDS = {"heritage": ("church", "cathedral", "basilica", "chapel", "shrine", "heritage", "museum"),
                  "leisure": ("park", "plaza", "garden", "maze"),
                  "coast": ("beach", "bay", "island", "wharf", "cove"),
                  "nature": ("falls", "spring", "river", "cave", "mount", "lake", "dam"),
                  "trade": ("market", "hub", "center", "shop", "shacks", "forge", "factory")}
GROUP_PICK = {"heritage": "A church", "leisure": "A park", "coast": "A beach", "nature": "A waterfall", "trade": "A market"}
QUEST_CATEGORY = {"culture_heritage": "cultural", "nature_outdoors": "eco", "activities_wellness": "eco",
                  "eat_drink": "food_trade", "shopping_local": "food_trade"}
# Not quest material: politically sensitive, or a likely duplicate listing of a place that already has content.
QUEST_EXCLUDE = ("marcos", "manaoag")
TRUST_RANK = {"lgu_verified": 0, "editorial": 1, "open_data": 2, "community": 3}


def h(*parts):
    return int(hashlib.sha256("|".join(parts).encode()).hexdigest(), 16)


def uid(*parts):
    return str(uuid.uuid5(NS, "|".join(parts)))


def pick(seq, n, *key):
    return sorted(seq, key=lambda x: h(*key, str(x)))[:n]


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


catalog = json.load(open("catalog.json", encoding="utf-8"))
allnames = json.load(open("allnames.json", encoding="utf-8"))
towns_with_name = defaultdict(set)  # lower(name) -> {(town, province)}
for name, town, prov in allnames:
    towns_with_name[name].add((town, prov))

for s in catalog:  # display name without stray trailing punctuation from open data
    s["display"] = s["name"].strip().rstrip(",;.").strip()

def core(town):
    """'Urdaneta City', 'City of San Fernando' and 'Urdaneta' are the same town in the catalog."""
    return (town or "").lower().removeprefix("city of ").removesuffix(" city").strip()


# Group by (province, town core); the town's display name is its most common spelling.
by_prov_core = defaultdict(list)
for s in catalog:
    if s["province"] in PROVINCES:
        by_prov_core[(s["province"], core(s["municipality"]))].append(s)
by_prov_town = {}
town_name = {}
for (prov, c), spots in by_prov_core.items():
    names = defaultdict(int)
    for x in spots:
        names[x["municipality"]] += 1
    town_name[(prov, c)] = max(sorted(names), key=lambda n: names[n])
    by_prov_town[(prov, town_name[(prov, c)])] = spots
towns_by_prov = defaultdict(list)
for (prov, c), name in town_name.items():
    towns_by_prov[prov].append(name)
provinces_of_core = defaultdict(set)
for prov, c in town_name:
    provinces_of_core[c].add(prov)


def town_options(s):
    """Correct town + 3 same-province towns that have no spot with this spot's name."""
    clash = {core(t) for t, p in towns_with_name[s["name"].lower()]} | {core(s["municipality"])}
    others = [t for t in towns_by_prov[s["province"]] if core(t) not in clash]
    if len(others) < 3:
        return None
    return [s["municipality"]] + pick(others, 3, "town", s["id"])


def province_ok(s):
    """The spot's name exists in only one province, so 'which province' has one answer."""
    return len({p for _, p in towns_with_name[s["name"].lower()]}) == 1


town_core = core


def gives_away(s):
    """The town is in the place's own name (e.g. Bacarra Church), so 'which town' is a giveaway."""
    return town_core(s["municipality"]) in s["display"].lower()


ALL_TOWN_CORES = {town_core(t) for _, t, _ in allnames if t}


# Names that read badly as "a place" or are ambiguous in the real world even if unique in the catalog:
# collective listings, people (their monuments), and saint dedications shared by many town churches.
NAME_EXCLUDE = ("baroque churches", "teofilo yldefonso", "diego silang", "marcos")
GENERIC_DEDICATION = re.compile(r"^(saint|st\.?|san|santo|santa|sta\.?|our lady|holy|immaculate)\b.*\b(parish church|church|parish)$", re.I)


def clean(s):
    """Usable as a question subject, distractor or quest: a real single place with a plain name."""
    d = s["display"]
    return (len(towns_with_name[s["name"].lower()]) == 1 and len(d.split()) >= 2
            and not any(c in d for c in ":(,") and " in " not in d.lower()
            and d.lower() not in ALL_TOWN_CORES
            and not any(w in d.lower() for w in NAME_EXCLUDE) and not GENERIC_DEDICATION.match(d))


def kind_options(s):
    sub = s.get("subcategory")
    if sub not in LABEL:
        return None
    name = s["display"].lower()
    others = [GROUP_PICK[g] for g in GROUP_PICK
              if g != GROUP[sub] and not any(k in name for k in GROUP_KEYWORDS[g])]
    if len(others) < 3:
        return None
    return [LABEL[sub]] + pick(others, 3, "kind", s["id"])


def shuffled(correct_first, *key):
    """Options with the correct one first -> deterministic shuffle; returns [(text, is_correct)]."""
    items = [(t, i == 0) for i, t in enumerate(correct_first)]
    return sorted(items, key=lambda x: h(*key, x[0]))


SEEN_IDS = set()


def once(i):
    assert i not in SEEN_IDS, f"duplicate id {i}"
    SEEN_IDS.add(i)
    return i


sql = ["-- Generated by scripts/seed/region1-content/generate.py. Idempotent.", "BEGIN;"]
summary = defaultdict(int)

# ---------------- Quizzes: one per town (skip towns that already have one) ----------------
for (prov, town), spots in sorted(by_prov_town.items()):
    if any(s["has_quiz"] for s in spots):
        summary["towns_skipped_existing_quiz"] += 1
        continue
    spots_sorted = sorted(spots, key=lambda s: (0 if s["image_url"] else 1, TRUST_RANK.get(s["trust_level"], 9), s["name"]))
    usable = [x for x in spots_sorted if clean(x) and province_ok(x)]
    s = next((x for x in usable if not gives_away(x) and town_options(x)), None) or next(iter(usable), None)
    if not s:
        summary["towns_skipped_ambiguous"] += 1
        continue
    questions = []
    if not gives_away(s):
        questions.append((f"{s['display']} is in which town?", f"{s['display']} is in {town}, {prov}.", "multiple_choice",
                          shuffled(town_options(s), "q1", s["id"])))
    questions.append((f"{s['display']} is in which province?", f"{s['display']} is in {town}, {prov}, part of Region I (Ilocos Region).",
                      "multiple_choice", shuffled([prov] + [p for p in PROVINCES if p != prov], "q2", s["id"])))
    ko = kind_options(s)
    if ko:
        questions.append((f"What kind of place is {s['display']}?", f"{s['display']} is listed as {ko[0].lower()}.",
                          "multiple_choice", shuffled(ko, "q3", s["id"])))
    questions.append((f"What is the capital of {prov}?", f"The capital of {prov} is {CAPITAL[prov]}.", "multiple_choice",
                      shuffled([CAPITAL[prov]] + [CAPITAL[p] for p in PROVINCES if p != prov], "q4", s["id"])))
    # True/false: another destination in the same province, in this town (true) or another town (false).
    peers = [x for x in catalog if x["province"] == prov and x["id"] != s["id"] and x["name"].lower() != s["name"].lower()
             and clean(x) and not gives_away(x)]
    same_town = [x for x in peers if core(x["municipality"]) == core(town)]
    if same_town and h("tfmode", s["id"]) % 2 == 0:
        peers = same_town
    if peers:
        other = pick(peers, 1, "tf", s["id"])[0]
        truth = core(other["municipality"]) == core(town)
        questions.append((f"True or false: {other['display']} is also in {town}.",
                          f"{other['display']} is in {other['municipality']}, {prov}.", "true_false",
                          [("True", truth), ("False", not truth)]))
    questions = questions[:5]

    quiz_id = once(f"seed-r1-quiz-{s['id']}")
    ver_id = f"seed-r1-qv-{s['id']}"
    title = (f"Know {town}, {prov}" if len(provinces_of_core[core(town)]) > 1 else f"Know {town}")[:200]
    count_word = {3: "Three", 4: "Four", 5: "Five"}[len(questions)]
    desc = f"{count_word} quick questions about {s['display']} and {town}, {prov}. Answer on site to earn XP."
    sql.append(f"INSERT INTO cultural_quizzes (id, destination_id, reward_scope_id, status, current_version, created_by, is_test) "
               f"VALUES ({q(quiz_id)}, {q(s['id'])}, {q(uid('scope', s['id']))}, 'published', 1, {q(ADMIN)}, FALSE) ON CONFLICT DO NOTHING;")
    sql.append(f"INSERT INTO cultural_quiz_versions (id, quiz_id, version, title, description, language, radius_meters, xp_reward, "
               f"time_limit_minutes, cooldown_hours, created_by, published_at, theme) VALUES ({q(ver_id)}, {q(quiz_id)}, 1, {q(title)}, "
               f"{q(desc)}, 'en', 200, 25, 30, 24, {q(ADMIN)}, NOW(), 'crt') ON CONFLICT DO NOTHING;")
    for i, (text, expl, qtype, opts) in enumerate(questions, start=1):
        qid = f"{ver_id}-q{i}"
        sql.append(f"INSERT INTO cultural_quiz_questions (id, version_id, ordinal, question_text, explanation, question_type, round) "
                   f"VALUES ({q(qid)}, {q(ver_id)}, {i}, {q(text)}, {q(expl)}, {q(qtype)}, 'main') ON CONFLICT DO NOTHING;")
        assert sum(c for _, c in opts) == 1 and len(opts) == (2 if qtype == "true_false" else 4), (s["name"], text)
        for j, (otext, correct) in enumerate(opts, start=1):
            sql.append(f"INSERT INTO cultural_quiz_options (id, question_id, ordinal, option_text, is_correct) "
                       f"VALUES ({q(qid + '-o' + str(j))}, {q(qid)}, {j}, {q(otext)}, {'TRUE' if correct else 'FALSE'}) ON CONFLICT DO NOTHING;")
    summary[f"quizzes_{prov}"] += 1

# ---------------- Daily questions (global pool) ----------------
def qotd(qid, text, expl, opts):
    once(qid)
    assert sum(c for _, c in opts) == 1 and len(opts) == 4, text
    sql.append(f"INSERT INTO qotd_questions (id, question_text, explanation, active, created_by) "
               f"VALUES ({q(qid)}, {q(text)}, {q(expl)}, TRUE, {q(ADMIN)}) ON CONFLICT DO NOTHING;")
    for j, (otext, correct) in enumerate(opts, start=1):
        sql.append(f"INSERT INTO qotd_options (id, question_id, ordinal, option_text, is_correct) "
                   f"VALUES ({q(qid + '-o' + str(j))}, {q(qid)}, {j}, {q(otext)}, {'TRUE' if correct else 'FALSE'}) ON CONFLICT DO NOTHING;")
    summary["qotd"] += 1

for prov in PROVINCES:
    if prov == "Pangasinan":
        continue  # qotd-seed-capital already asks this
    qotd(f"qotd-r1-capital-{prov.lower().replace(' ', '-')}", f"What is the capital of {prov}?",
         f"The capital of {prov} is {CAPITAL[prov]}.",
         shuffled([CAPITAL[prov]] + [CAPITAL[p] for p in PROVINCES if p != prov], "qcap", prov))
existing_qotd_spots = {"cape bolinao lighthouse", "pangasinan provincial capitol", "patar beach", "hundred islands national park"}
for (prov, town), spots in sorted(by_prov_town.items()):
    for s in sorted(spots, key=lambda x: x["name"])[:3]:  # up to 3 per town
        if s["name"].lower() in existing_qotd_spots or not clean(s):
            continue
        if h("qmode", s["id"]) % 3 == 0 and province_ok(s):
            qotd(f"qotd-r1-prov-{s['id']}", f"{s['display']} is in which province?", f"{s['display']} is in {town}, {prov}.",
                 shuffled([prov] + [p for p in PROVINCES if p != prov], "qprov", s["id"]))
        else:
            if gives_away(s):
                continue
            to = town_options(s)
            if to:
                qotd(f"qotd-r1-town-{s['id']}", f"{s['display']} is in which town?", f"{s['display']} is in {town}, {prov}.",
                     shuffled(to, "qtown", s["id"]))

# ---------------- A few quests (explore testing): 2 IN, 1 IS, 1 LU, 2 PG ----------------
want = {"Ilocos Norte": 2, "Ilocos Sur": 1, "La Union": 1, "Pangasinan": 2}
quest_ids = []
for prov, n in want.items():
    cands = [s for s in catalog if s["province"] == prov and s["image_url"] and not s["has_quest"] and not s["quest_id"]
             and clean(s) and not any(w in s["name"].lower() for w in QUEST_EXCLUDE)]
    for s in pick(cands, n, "quest", prov):
        slug = "".join(ch for ch in s["slug"] if ch.isalnum() or ch in "_-")[:36]
        qid = once(f"quest-{slug}-seedr1")
        quest_ids.append(qid)
        marker = "JDQ-" + uid("marker", s["id"]).replace("-", "")[:8].upper()
        steps = [
            {"key": f"task_{uid('t1', s['id'])}", "title": f"Arrive at {s['display']}", "gps_lat": s["gps_lat"], "gps_lng": s["gps_lng"],
             "required": True, "step_order": 1, "description": "Check in near the main landmark or visitor entrance.",
             "verification": {"type": "location", "fence": {"lat": s["gps_lat"], "lng": s["gps_lng"], "radius_meters": 150}},
             "radius_meters": 150, "checkpoint_type": "location"},
            {"key": f"task_{uid('t2', s['id'])}", "hint": "Take a clear photo of the landmark or site.", "title": "Snap the view",
             "gps_lat": s["gps_lat"], "gps_lng": s["gps_lng"], "required": True, "step_order": 2,
             "description": "Take one clear photo of the place.",
             "verification": {"type": "photo", "fence": None, "prompt": "Take a clear photo of the landmark or site.", "require_gps": True},
             "radius_meters": 150, "checkpoint_type": "photo"},
        ]
        sql.append(
            "INSERT INTO quests (id, title, description, category, location_name, gps_lat, gps_lng, radius_meters, reward_points, "
            "marker_code, marker_image_url, is_active, is_test, author_id, status, version, steps, step_order_mode, created_at, updated_at, "
            f"funding_required) VALUES ({q(qid)}, {q('Explore ' + s['display'])}, "
            f"{q(f'Visit {s['display']} in {s['municipality']}, {prov}: check in and snap one photo.')}, "
            f"{q(QUEST_CATEGORY.get(s['category'], 'eco'))}, {q(s['display'])}, {s['gps_lat']}, {s['gps_lng']}, 150, 20, {q(marker)}, "
            f"{q(s['image_url'])}, TRUE, FALSE, {q(ADMIN)}, 'published', 1, {q(json.dumps(steps))}::jsonb, 'sequential', NOW(), NOW(), FALSE) "
            "ON CONFLICT DO NOTHING;")
        sql.append(f"INSERT INTO reviewed_quest_spot_bindings (id, quest_id, spot_id, binding_version, status, reviewed_by, notes, is_test, "
                   f"created_at, updated_at) VALUES ({q(uid('binding', s['id']))}, {q(qid)}, {q(s['id'])}, 'v1', 'active', {q(ADMIN)}, "
                   f"'Region 1 seed quest (owner 2026-11-26)', FALSE, NOW(), NOW()) ON CONFLICT DO NOTHING;")
        sql.append(f"UPDATE spots SET quest_id = {q(qid)}, updated_at = NOW() WHERE id = {q(s['id'])} AND quest_id IS NULL;")
        summary[f"quests_{prov}"] += 1

sql.append("COMMIT;")
open("seed.sql", "w", encoding="utf-8", newline="\n").write("\n".join(sql) + "\n")

rollback = f"""-- Removes exactly what seed.sql added. Refuses if travelers already played the seeded content.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cultural_quiz_attempts WHERE quiz_id LIKE 'seed-r1-quiz-%')
     OR EXISTS (SELECT 1 FROM quest_attempts WHERE quest_id LIKE '%-seedr1') THEN
    RAISE EXCEPTION 'seeded content already has attempts; archive instead of deleting';
  END IF;
END $$;
UPDATE spots SET quest_id = NULL, updated_at = NOW() WHERE quest_id LIKE '%-seedr1';
DELETE FROM reviewed_quest_spot_bindings WHERE quest_id LIKE '%-seedr1';
DELETE FROM quests WHERE id LIKE '%-seedr1';
DELETE FROM question_of_the_day WHERE question_id LIKE 'qotd-r1-%';
DELETE FROM qotd_questions WHERE id LIKE 'qotd-r1-%';
DELETE FROM cultural_quizzes WHERE id LIKE 'seed-r1-quiz-%';
COMMIT;
"""
open("rollback.sql", "w", encoding="utf-8", newline="\n").write(rollback)
print(dict(sorted(summary.items())))
print("quests:", quest_ids)
