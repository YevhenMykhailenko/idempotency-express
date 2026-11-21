export class StoreCapacityError extends Error {
  constructor(message = "Store capacity exceeded") {
    super(message);
    this.name = "StoreCapacityError";
  }
}

export class StoreDataError extends Error {
  constructor(message = "Invalid store data") {
    super(message);
    this.name = "StoreDataError";
  }
}

/** Internal distinction for a valid response that exceeds the storage budget. */
export class StoreLimitError extends StoreDataError {}
