import path from "path"

process.env.QUERYAI_DB = ":memory:"
process.env.QUERYAI_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.QUERYAI_DISABLE_MODELS_FETCH = "true"
