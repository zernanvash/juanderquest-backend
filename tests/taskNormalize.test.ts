import { describe, it, expect } from '@jest/globals';
import { normalizeTasks, publicTask, publicTasks } from '../src/quests/taskNormalize.js';

describe('Quest Builder taskNormalize', () => {
  it('normalizes legacy v1 location step to v2 QuestTask', () => {
    const v1Steps = [
      {
        step_order: 1,
        title: 'Arrive at the beach',
        description: 'Find the lifeguard post',
        checkpoint_type: 'location',
        required: true,
        gps_lat: 16.03,
        gps_lng: 119.78,
        radius_meters: 80,
      },
    ];

    const tasks = normalizeTasks(v1Steps);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.key).toMatch(/^task_/);
    expect(task.step_order).toBe(1);
    expect(task.title).toBe('Arrive at the beach');
    expect(task.checkpoint_type).toBe('location');
    expect(task.verification).toEqual({
      type: 'location',
      fence: { lat: 16.03, lng: 119.78, radius_meters: 80 },
    });
    expect(task.gps_lat).toBe(16.03);
    expect(task.gps_lng).toBe(119.78);
    expect(task.radius_meters).toBe(80);
  });

  it('normalizes legacy v1 qr step, creates marker_code, and sanitizes it with publicTask', () => {
    const v1Steps = [
      {
        step_order: 1,
        title: 'Scan Heritage Plaque',
        description: 'Find the brass marker',
        checkpoint_type: 'qr',
        required: true,
        gps_lat: 16.04,
        gps_lng: 120.33,
        radius_meters: 50,
        marker_code: 'legacy-secret-code-123',
      },
    ];

    const tasks = normalizeTasks(v1Steps);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.checkpoint_type).toBe('qr');
    expect(task.marker_code).toBe('legacy-secret-code-123');
    expect((task.verification as any).marker_code).toBe('legacy-secret-code-123');

    const sanitized = publicTask(task);
    expect(sanitized.marker_code).toBeUndefined();
    expect((sanitized.verification as any).marker_code).toBeUndefined();
    // Fence remains visible so travelers know where the QR code is located
    expect((sanitized.verification as any).fence).toEqual({ lat: 16.04, lng: 120.33, radius_meters: 50 });
  });

  it('normalizes legacy v1 photo step and respects hint as prompt', () => {
    const v1Steps = [
      {
        step_order: 1,
        title: 'Lighthouse Sunset',
        description: 'Capture the setting sun',
        checkpoint_type: 'photo',
        required: true,
        hint: 'Framed with the rocky shoreline',
        gps_lat: 16.3,
        gps_lng: 119.9,
      },
    ];

    const tasks = normalizeTasks(v1Steps);
    const task = tasks[0];
    expect(task.checkpoint_type).toBe('photo');
    expect(task.verification.type).toBe('photo');
    if (task.verification.type === 'photo') {
      expect(task.verification.prompt).toBe('Framed with the rocky shoreline');
      expect(task.verification.require_gps).toBe(true);
      expect(task.verification.fence?.lat).toBe(16.3);
    }
  });

  it('converts unverified action view_story to optional task (required: false)', () => {
    const v1Steps = [
      {
        step_order: 1,
        title: 'Learn the Legend',
        description: 'Read the historical account',
        checkpoint_type: 'action',
        action_kind: 'view_story',
        action_target_id: 'spot-story-1',
        required: true,
      },
    ];

    const tasks = normalizeTasks(v1Steps);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].required).toBe(false); // Demoted because view_story cannot be verified
    expect(tasks[0].verification.type).toBe('action');
  });

  it('preserves existing v2 task keys and configs', () => {
    const v2Steps = [
      {
        key: 'task_stable_key_999',
        step_order: 1,
        title: 'Collect AR Gem',
        description: 'Point camera at the reef',
        required: true,
        checkpoint_type: 'ar',
        verification: {
          type: 'ar',
          fence: { lat: 16.1, lng: 120.0, radius_meters: 50 },
          object: 'gem',
          color: '#3B82F6',
        },
      },
    ];

    const tasks = normalizeTasks(v2Steps);
    expect(tasks[0].key).toBe('task_stable_key_999');
    expect(tasks[0].verification).toEqual({
      type: 'ar',
      fence: { lat: 16.1, lng: 120.0, radius_meters: 50 },
      object: 'gem',
      color: '#3B82F6',
    });
  });

  it('uses spot coordinates as fallback when step coordinates are omitted', () => {
    const v1Steps = [
      {
        step_order: 1,
        title: 'Spot Check-in',
        description: 'Arrive at the destination',
        checkpoint_type: 'location',
        required: true,
      },
    ];

    const spot = { gps_lat: 16.25, gps_lng: 120.45 };
    const tasks = normalizeTasks(v1Steps, spot);
    expect(tasks[0].gps_lat).toBe(16.25);
    expect(tasks[0].gps_lng).toBe(120.45);
    expect((tasks[0].verification as any).fence.lat).toBe(16.25);
    expect((tasks[0].verification as any).fence.lng).toBe(120.45);
  });
});
