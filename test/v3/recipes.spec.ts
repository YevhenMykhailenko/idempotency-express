import { MemoryStore } from "../../src/index.js";
import { runRecipeContract } from "../helpers/recipe-contract.js";

runRecipeContract("MemoryStore", () => ({ store: new MemoryStore() }));
