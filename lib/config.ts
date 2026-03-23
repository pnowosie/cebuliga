import { readFile } from "fs/promises";
import { join } from "path";

interface LoadConfigOptions {
  configDir: string;
  required?: boolean;
  filename?: string;
}

export async function loadConfig<T>(options: LoadConfigOptions): Promise<T> {
  const { configDir, required = false, filename = "config.json" } = options;
  const filePath = join(configDir, filename);
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      if (required) throw new Error(`Config file not found: ${filePath}`);
      return {} as T;
    }
    throw new Error(`Failed to load config from ${filePath}: ${error.message}`);
  }
}
