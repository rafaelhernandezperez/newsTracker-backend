import { defineSecret } from "firebase-functions/params";

/** Hugging Face token used by all functions that enrich news with AI. */
export const hfToken = defineSecret("HF_TOKEN");
