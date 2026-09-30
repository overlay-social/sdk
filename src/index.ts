// Package root. Re-exports the overlay read client so `@overlay-social/sdk`
// keeps working exactly as before; each module is also available on its own
// subpath (see the `exports` map in package.json).
export * from './read/index.js'
