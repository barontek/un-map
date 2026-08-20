/* UN map - shared configuration.
 * Loaded by both index.html and editor.html BEFORE their app scripts.
 * Plain globals (no modules) to match the rest of the codebase.
 */

// The PNG is the coordinate space: GeoJSON coords are in these pixel units.
const IMG_W = 2753;
const IMG_H = 1399;

// Display order for the legend, filters and composition bar.
const STATUS_ORDER = ['p5', 'sc', 'normal', 'observer', 'disputed', 'suspended', 'nogroup'];

// Colours are tuned for a dark ocean (--ocean #0A1526). The originals were
// picked against a white ocean: #00278b read as black, #232323 vanished
// entirely and #adadad glared. `label` matches the wording baked into map.png
// so Classic mode stays coherent.
const STATUS_META = {
  p5:        { label: 'Permanent 5',      color: '#2B4BD8' },
  sc:        { label: 'Security Council', color: '#1E7BD6' },
  normal:    { label: 'General Assembly', color: '#5AA0E8' },
  observer:  { label: 'Observer',         color: '#2ECC71' },
  disputed:  { label: 'Disputed',         color: '#E63946' },
  suspended: { label: 'Suspended',        color: '#3A4152' },
  nogroup:   { label: 'Non-Member State', color: '#6B7280' },
  unknown:   { label: 'Not on map',       color: '#2A3444' },
};

// Statuses that get a flag emoji (others are not represented in the UN).
const MEMBER_STATUSES = ['p5', 'sc', 'normal', 'observer'];

// Polygons smaller than this (px^2) render as clickable flag markers instead.
const TINY_AREA = 10;
