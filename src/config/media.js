// The client's own photos and videos (originals in media/client/, polished copies in public/
// by `npm run media:prepare`). Captions describe what's on screen; edit freely.

// Home page "Reels": upright clips, muted until the visitor taps the sound button.
const REELS = [
  { id: 'reel-01', source: '9.mp4', caption: 'Platinum blonde, fresh out of the chair' },
  { id: 'reel-02', source: '11.mp4', caption: 'Copper colour, clean shape' },
  { id: 'reel-03', source: '8.mp4', caption: 'Razor-sharp line-up' },
  { id: 'reel-04', source: '6.mp4', caption: 'Copper bob, finished' },
  { id: 'reel-05', source: '4.mp4', caption: 'Colour in progress' },
  { id: 'reel-06', source: '2.mp4', caption: 'Gold, up close' },
  { id: 'reel-07', source: '1.mp4', caption: 'Low cut with a crisp edge' },
  { id: 'reel-08', source: '12.mp4', caption: 'Short copper crop' },
];

// Photos: the barber portrait and the Lookbook (gallery) shots.
const PHOTOS = [
  { id: 'uche', source: '2.jpeg', widths: [500, 810] },
  { id: 'look-01', source: '3.jpeg', widths: [480, 810], caption: 'Gold crop with a sharp part' },
  { id: 'look-02', source: '6.jpeg', widths: [480, 810], caption: 'Copper twists, clean edge' },
  { id: 'look-03', source: '4.jpeg', widths: [480, 810], caption: 'Line-up, colour set' },
  { id: 'look-04', source: '7.jpeg', widths: [480, 810], caption: 'Copper waves' },
  { id: 'look-05', source: '1.jpeg', widths: [480, 810], caption: 'Busy Saturday on the floor' },
  { id: 'look-06', source: '5.jpeg', widths: [480, 810], caption: 'Fresh cut, ready to go' },
];

module.exports = { REELS, PHOTOS };
