#!/usr/bin/env python3
import sqlite3
import os
import shutil
import json

win_base = '/mnt/c/Users/HP/.gemini/antigravity-cli'
wsl_base = '/home/kaizo/.gemini/antigravity-cli'

win_db = os.path.join(win_base, 'conversation_summaries.db')
wsl_db = os.path.join(wsl_base, 'conversation_summaries.db')

if not os.path.exists(win_db):
    print(f"Windows DB not found at {win_db}")
    exit(1)

# Copy to /tmp to prevent DrvFs WAL lock collision with active Windows process
tmp_db = '/tmp/win_conversation_summaries.db'
shutil.copy2(win_db, tmp_db)
for extra in ['-wal', '-shm']:
    if os.path.exists(win_db + extra):
        try:
            shutil.copy2(win_db + extra, tmp_db + extra)
        except Exception:
            pass

con_win = sqlite3.connect(tmp_db)
cur_win = con_win.cursor()

# Connect to WSL DB
con_wsl = sqlite3.connect(wsl_db)
cur_wsl = con_wsl.cursor()

# Query JuanderQuest sessions from Windows
cur_win.execute("""
    SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
           status, source, project_id, agent_name, parent_conversation_id, nesting_depth,
           battle_id, winning_conversation_id, not_fully_idle, killed, last_user_input_time,
           last_user_input_step_index, app_data_dir, raw_summary, group_id
    FROM conversation_summaries
    WHERE workspace_uris LIKE '%JuanderQuest%'
    ORDER BY last_modified_time DESC
""")
rows = cur_win.fetchall()
print(f"Found {len(rows)} JuanderQuest sessions in Windows database.")

synced_count = 0
for row in rows:
    cid = row[0]
    title = row[1]
    
    # Adapt workspace_uris to include WSL path
    try:
        uris = json.loads(row[5]) if row[5] else []
    except Exception:
        uris = []
    
    wsl_uri = "file:///mnt/c/Users/HP/Desktop/Code/JuanderQuest"
    win_uri = "file:///C:/Users/HP/Desktop/Code/JuanderQuest"
    
    if wsl_uri not in uris:
        uris.insert(0, wsl_uri)
    if win_uri not in uris:
        uris.append(win_uri)
    new_uris_json = json.dumps(uris)
    
    # 1. Copy conversation db files if present
    for ext in ['.db', '.db-shm', '.db-wal']:
        src_conv = os.path.join(win_base, 'conversations', cid + ext)
        dst_conv = os.path.join(wsl_base, 'conversations', cid + ext)
        if os.path.exists(src_conv):
            os.makedirs(os.path.dirname(dst_conv), exist_ok=True)
            try:
                shutil.copy2(src_conv, dst_conv)
            except Exception:
                pass

    # 2. Copy annotations
    src_ann = os.path.join(win_base, 'annotations', cid + '.pbtxt')
    dst_ann = os.path.join(wsl_base, 'annotations', cid + '.pbtxt')
    if os.path.exists(src_ann):
        os.makedirs(os.path.dirname(dst_ann), exist_ok=True)
        try:
            shutil.copy2(src_ann, dst_ann)
        except Exception:
            pass

    # 3. Symlink or copy brain directory
    src_brain = os.path.join(win_base, 'brain', cid)
    dst_brain = os.path.join(wsl_base, 'brain', cid)
    if os.path.exists(src_brain):
        os.makedirs(os.path.dirname(dst_brain), exist_ok=True)
        if os.path.islink(dst_brain):
            pass
        elif os.path.exists(dst_brain):
            pass
        else:
            try:
                os.symlink(src_brain, dst_brain)
            except Exception:
                pass

    # 4. Insert or update in WSL conversation_summaries.db
    new_row = list(row)
    new_row[5] = new_uris_json
    
    cur_wsl.execute("""
        INSERT OR REPLACE INTO conversation_summaries (
            conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
            status, source, project_id, agent_name, parent_conversation_id, nesting_depth,
            battle_id, winning_conversation_id, not_fully_idle, killed, last_user_input_time,
            last_user_input_step_index, app_data_dir, raw_summary, group_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, new_row)
    synced_count += 1

con_wsl.commit()
con_win.close()
con_wsl.close()
print(f"Successfully synced {synced_count} JuanderQuest sessions into WSL Antigravity!")
