import { parseClientFrame } from '../src/ws/channel-router.service';

describe('parseClientFrame', () => {
  it('accepts a bare join on notifications', () => {
    expect(parseClientFrame(JSON.stringify({ channel: 'notifications', action: 'join' }))).toEqual({
      channel: 'notifications',
      action: 'join',
      payload: undefined,
    });
  });

  it('accepts a chat:{id} join with a numeric lastSeen', () => {
    const frame = parseClientFrame(JSON.stringify({ channel: 'chat:c1', action: 'join', payload: { lastSeen: 7 } }));
    expect(frame).toEqual({ channel: 'chat:c1', action: 'join', payload: { lastSeen: 7 } });
  });

  it('accepts leave', () => {
    expect(parseClientFrame(JSON.stringify({ channel: 'chat:c1', action: 'leave' }))?.action).toBe('leave');
  });

  it.each([
    ['not json at all', 'not json at all'],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['missing channel', JSON.stringify({ action: 'join' })],
    ['unknown channel', JSON.stringify({ channel: 'unknown', action: 'join' })],
    ['bare "chat:" with nothing after it', JSON.stringify({ channel: 'chat:', action: 'join' })],
    ['missing action', JSON.stringify({ channel: 'notifications' })],
    ['unrecognized action', JSON.stringify({ channel: 'notifications', action: 'subscribe' })],
    ['non-object payload', JSON.stringify({ channel: 'notifications', action: 'join', payload: 'nope' })],
  ])('rejects: %s', (_label, raw) => {
    expect(parseClientFrame(raw)).toBeNull();
  });
});
