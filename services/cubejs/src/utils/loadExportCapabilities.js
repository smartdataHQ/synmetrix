function getNormalizedDbType(securityContext) {
  const dbType = securityContext?.userScope?.dataSource?.dbType;
  return typeof dbType === "string" ? dbType.toLowerCase() : null;
}

export function resolveLoadExportCapabilities(securityContext) {
  const dbType = getNormalizedDbType(securityContext);

  if (dbType === "clickhouse") {
    return {
      semanticRowStream: true,
      nativeCsvPassthrough: true,
      nativeArrowPassthrough: true,
      incrementalArrowEncode: true,
    };
  }

  return {
    semanticRowStream: false,
    nativeCsvPassthrough: false,
    nativeArrowPassthrough: false,
    incrementalArrowEncode: false,
  };
}

export function canSemanticStreamLoadExport(format, capabilities) {
  if (format === "csv") {
    return Boolean(capabilities?.semanticRowStream);
  }

  if (format === "arrow") {
    return Boolean(
      capabilities?.semanticRowStream && capabilities?.incrementalArrowEncode
    );
  }

  return false;
}
