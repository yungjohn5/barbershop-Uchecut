// In-memory stand-in for the Cloudinary SDK (use with jest.mock('cloudinary', ...)).
// Records uploads and deletes; `state` lets a test simulate small images or failures.
const { Writable } = require('stream');

const state = {
  width: 1000,
  height: 800,
  fail: false,
  destroyFail: false,
  uploads: [],
  destroyed: [],
};
let counter = 0;

const v2 = {
  config: jest.fn(),
  uploader: {
    upload_stream: jest.fn((opts, cb) => {
      const chunks = [];
      return new Writable({
        write(chunk, _enc, next) {
          chunks.push(chunk);
          next();
        },
        final(done) {
          done();
          setImmediate(() => {
            if (state.fail) return cb(new Error('Cloudinary 500'));
            counter += 1;
            const result = {
              public_id: `${opts.folder}/${opts.public_id}`,
              version: 1700000000 + counter,
              width: state.width,
              height: state.height,
              bytes: Buffer.concat(chunks).length,
            };
            state.uploads.push({ opts, result });
            return cb(null, result);
          });
        },
      });
    }),
    destroy: jest.fn(async (publicId) => {
      state.destroyed.push(publicId);
      if (state.destroyFail) throw new Error('destroy failed');
      return { result: 'ok' };
    }),
  },
};

function reset() {
  Object.assign(state, {
    width: 1000,
    height: 800,
    fail: false,
    destroyFail: false,
    uploads: [],
    destroyed: [],
  });
  v2.uploader.upload_stream.mockClear();
  v2.uploader.destroy.mockClear();
}

// Tiny buffers with real magic bytes (Cloudinary is mocked, so no decoding happens).
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

module.exports = { v2, state, reset, png, jpeg };
