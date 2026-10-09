class HttpError extends Error {
  constructor(status, message, { code, details, expose = true } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

class NotFoundError extends HttpError {
  constructor(message = 'Not found') {
    super(404, message, { code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

class ValidationError extends HttpError {
  constructor(message, details) {
    super(400, message, { code: 'VALIDATION_ERROR', details });
    this.name = 'ValidationError';
  }
}

// The chosen slot was taken (or became invalid) between viewing and booking.
class SlotTakenError extends HttpError {
  constructor(message = 'That time was just taken. Please pick another slot.') {
    super(409, message, { code: 'SLOT_TAKEN' });
    this.name = 'SlotTakenError';
  }
}

module.exports = { HttpError, NotFoundError, ValidationError, SlotTakenError };
