// In some environments the Stellar SDK expects Buffer/global in the browser.
import { Buffer } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = Buffer;
if (!globalThis.global) globalThis.global = globalThis;
