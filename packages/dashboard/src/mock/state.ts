import type { StateEvent } from './types';

const SESSION = 'sess_mock_001';
const BASE = Date.now() - 300_000;

export const MOCK_STATE: StateEvent[] = [
  {
    eventId: 'state_001', sessionId: SESSION, timestamp: BASE, eventType: 'state',
    storeId: 'auth', library: 'zustand', phase: 'init',
    state: { user: { id: 1, name: 'Edwin', email: 'edwin@example.com' }, token: 'tok_***', isAuthenticated: true },
  },
  {
    eventId: 'state_002', sessionId: SESSION, timestamp: BASE + 500, eventType: 'state',
    storeId: 'campaigns', library: 'zustand', phase: 'init',
    state: { items: [], loading: true, error: null },
  },
  {
    eventId: 'state_003', sessionId: SESSION, timestamp: BASE + 1000, eventType: 'state',
    storeId: 'ui', library: 'zustand', phase: 'init',
    state: { sidebarOpen: true, theme: 'dark', activeModal: null },
  },
  {
    eventId: 'state_004', sessionId: SESSION, timestamp: BASE + 3000, eventType: 'state',
    storeId: 'campaigns', library: 'zustand', phase: 'update',
    state: { items: [{ id: 1, name: 'Summer Sale' }, { id: 2, name: 'Holiday Push' }], loading: false, error: null },
    previousState: { items: [], loading: true, error: null },
    diff: { items: { from: [], to: [{ id: 1, name: 'Summer Sale' }, { id: 2, name: 'Holiday Push' }] }, loading: { from: true, to: false } },
    action: { type: 'campaigns/loaded', payload: { count: 2 } },
  },
  {
    eventId: 'state_005', sessionId: SESSION, timestamp: BASE + 10000, eventType: 'state',
    storeId: 'campaigns', library: 'zustand', phase: 'update',
    state: { items: [{ id: 1, name: 'Summer Sale' }, { id: 2, name: 'Holiday Push' }, { id: 3, name: 'New Campaign' }], loading: false, error: null },
    previousState: { items: [{ id: 1, name: 'Summer Sale' }, { id: 2, name: 'Holiday Push' }], loading: false, error: null },
    diff: { items: { from: '2 items', to: '3 items' } },
    action: { type: 'campaigns/created', payload: { id: 3, name: 'New Campaign' } },
  },
  {
    eventId: 'state_006', sessionId: SESSION, timestamp: BASE + 15000, eventType: 'state',
    storeId: 'ui', library: 'zustand', phase: 'update',
    state: { sidebarOpen: false, theme: 'dark', activeModal: null },
    previousState: { sidebarOpen: true, theme: 'dark', activeModal: null },
    diff: { sidebarOpen: { from: true, to: false } },
    action: { type: 'ui/toggleSidebar' },
  },
  {
    eventId: 'state_007', sessionId: SESSION, timestamp: BASE + 20000, eventType: 'state',
    storeId: 'auth', library: 'zustand', phase: 'update',
    state: { user: { id: 1, name: 'Edwin', email: 'edwin@example.com' }, token: 'tok_new_***', isAuthenticated: true },
    previousState: { user: { id: 1, name: 'Edwin', email: 'edwin@example.com' }, token: 'tok_***', isAuthenticated: true },
    diff: { token: { from: 'tok_***', to: 'tok_new_***' } },
    action: { type: 'auth/refreshToken' },
  },
  {
    eventId: 'state_008', sessionId: SESSION, timestamp: BASE + 25000, eventType: 'state',
    storeId: 'ui', library: 'zustand', phase: 'update',
    state: { sidebarOpen: false, theme: 'dark', activeModal: 'create-campaign' },
    previousState: { sidebarOpen: false, theme: 'dark', activeModal: null },
    diff: { activeModal: { from: null, to: 'create-campaign' } },
    action: { type: 'ui/openModal', payload: { modal: 'create-campaign' } },
  },
  {
    eventId: 'state_009', sessionId: SESSION, timestamp: BASE + 30000, eventType: 'state',
    storeId: 'campaigns', library: 'zustand', phase: 'update',
    state: { items: [{ id: 1, name: 'Summer Sale' }, { id: 2, name: 'Holiday Push' }, { id: 3, name: 'New Campaign' }], loading: false, error: 'Validation failed: budget must be positive' },
    previousState: { items: [{ id: 1, name: 'Summer Sale' }, { id: 2, name: 'Holiday Push' }, { id: 3, name: 'New Campaign' }], loading: false, error: null },
    diff: { error: { from: null, to: 'Validation failed: budget must be positive' } },
    action: { type: 'campaigns/updateFailed', payload: { campaignId: 99, error: 'Validation failed' } },
  },
  {
    eventId: 'state_010', sessionId: SESSION, timestamp: BASE + 35000, eventType: 'state',
    storeId: 'ui', library: 'zustand', phase: 'update',
    state: { sidebarOpen: false, theme: 'dark', activeModal: null },
    previousState: { sidebarOpen: false, theme: 'dark', activeModal: 'create-campaign' },
    diff: { activeModal: { from: 'create-campaign', to: null } },
    action: { type: 'ui/closeModal' },
  },
];
