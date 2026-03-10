import { prepareCompiler } from "@cubejs-backend/schema-compiler";

/**
 * In-memory schema file repository that satisfies the SchemaFileRepository
 * interface from @cubejs-backend/shared. Each file has { fileName, content }.
 */
class InMemorySchemaFileRepository {
  constructor(files) {
    this.files = files;
  }

  localPath() {
    return "/";
  }

  async dataSchemaFiles() {
    return this.files;
  }
}

/**
 * Map a CompilerErrorInterface to the response format.
 *
 * CompilerErrorInterface: { message, plainMessage?, fileName?, lineNumber?, position? }
 */
function mapCompilerError(err) {
  return {
    severity: "error",
    message: err.plainMessage || err.message || String(err),
    fileName: err.fileName || null,
    startLine: err.lineNumber ? Number(err.lineNumber) : null,
    startColumn: err.position != null ? Number(err.position) : null,
    endLine: null,
    endColumn: null,
  };
}

/**
 * Map a SyntaxErrorInterface to the response format.
 *
 * SyntaxErrorInterface: { message, plainMessage?, loc: { start: { line, column }, end?: { line, column } } | null }
 */
function mapSyntaxWarning(warn) {
  const loc = warn.loc || {};
  const start = loc.start || {};
  const end = loc.end || {};

  return {
    severity: "warning",
    message: warn.plainMessage || warn.message || String(warn),
    fileName: null,
    startLine: start.line != null ? Number(start.line) : null,
    startColumn: start.column != null ? Number(start.column) : null,
    endLine: end.line != null ? Number(end.line) : null,
    endColumn: end.column != null ? Number(end.column) : null,
  };
}

export default async (req, res) => {
  const { files } = req.body || {};

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({
      code: "validate_missing_files",
      message: "The files parameter is required and must be a non-empty array of { fileName, content }.",
    });
  }

  try {
    const repo = new InMemorySchemaFileRepository(files);
    const { compiler } = prepareCompiler(repo, {
      allowNodeRequire: false,
      standalone: true,
    });

    let compileError = null;
    try {
      await compiler.compile();
    } catch (err) {
      // compile() throws a CompileError when there are validation errors.
      // The errors are already collected in compiler.errorsReport — we just
      // need to suppress the throw and read them below.
      compileError = err;
    }

    const errorsReport = compiler.errorsReport;
    const rawErrors = errorsReport ? errorsReport.getErrors() : [];
    const rawWarnings = errorsReport ? errorsReport.getWarnings() : [];

    // If compile threw but no structured errors were collected, surface the
    // thrown error as a single error entry.
    if (compileError && rawErrors.length === 0) {
      return res.json({
        valid: false,
        errors: [
          {
            severity: "error",
            message: compileError.message || String(compileError),
            fileName: null,
            startLine: null,
            startColumn: null,
            endLine: null,
            endColumn: null,
          },
        ],
        warnings: rawWarnings.map(mapSyntaxWarning),
      });
    }

    const errors = rawErrors.map(mapCompilerError);
    const warnings = rawWarnings.map(mapSyntaxWarning);

    return res.json({
      valid: errors.length === 0,
      errors,
      warnings,
    });
  } catch (err) {
    console.error("Validation endpoint error:", err);
    return res.status(500).json({
      code: "validate_error",
      message: err.message || String(err),
    });
  }
};
