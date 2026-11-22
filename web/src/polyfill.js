// Stellar SDK bazi ortamlarda tarayicida Buffer/global bekler.
import { Buffer } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.global) globalThis.global = globalThis;
