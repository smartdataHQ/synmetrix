"use strict";

const disabled = () => {
  const error = new Error(
    "Archive extraction is disabled in the production runtime",
  );
  error.code = "CUBE_RUNTIME_ARCHIVE_EXTRACTION_DISABLED";
  throw error;
};

module.exports = disabled;
module.exports.default = disabled;
