import YAML from "yaml";
import createMd5Hex from "./md5Hex.js";

// Curated, read-only ClickHouse Cube models for Auðvitað / QuickLookup SQL access
// (Pro/Fag = 27 public tables, Enterprise/Fyrirtæki = 31 tables adding 4 Trading Economics tables).
//
// Security invariants:
// 1. Every cst.data_points model filters strictly to partition = '_open_' AND
//    access_type = 'Public' AND an explicit series_gid / data_service_gid allowlist.
//    Private tenant partitions (e.g. blue.is) are never readable.
// 2. Every ql.calendar_events model filters strictly to is_deleted = 0 AND
//    access = 'Public' AND explicit (partition, collection_gid) pairs.
// 3. Licensed third-party Trading Economics datasets (PREMIUM_CUBES) are omitted
//    from the compiled schema unless `premium === true` (Fyrirtæki / enterprise).

const DATA_SERVICE = {
  fx: "14573f08-9a1c-59b2-ae50-f66d2106a791",
  indicators: "8c4579d7-c76c-5ed5-8ea3-b5d957d32c1b",
  indices: "f85f7533-0b8a-5a0a-86da-09b826b752f1",
  bonds: "d24a87a7-3444-5093-bf5b-33cdae07e914",
  commodities: "49625cce-4413-5807-a9ed-4896f50fd44d",
  crypto: "d15d9361-8861-5ed8-8135-43d24009d7e2",
  equities: "9470a103-d909-5007-9c3b-097eb1cef968",
};

// --- ClickHouse SQL expression helpers ---

/** True NULL instead of ClickHouse Map's default 0.0 when a metric key is absent. */
const numMetric = (col, key) =>
  `if(mapContains(${col}, '${key}'), ${col}['${key}'], CAST(NULL AS Nullable(Float64)))`;

/** Case-insensitive boolean check for stringified Python/PG dimension booleans ('True'/'true'/'1'). */
const boolDim = (col, key) =>
  `lower(${col}['${key}']) IN ('true', '1', 'yes')`;

/** Guards Null Island (0.0, 0.0) unknown-location sentinel to SQL NULL. */
const safeLat = (pt = "location_point") =>
  `if(${pt}.1 = 0 AND ${pt}.2 = 0, CAST(NULL AS Nullable(Float64)), toFloat64(${pt}.2))`;

const safeLon = (pt = "location_point") =>
  `if(${pt}.1 = 0 AND ${pt}.2 = 0, CAST(NULL AS Nullable(Float64)), toFloat64(${pt}.1))`;

/** Guards Null Island (0.0, 0.0) and falls back to decoding the row's geohash center. */
const geoLat = (pt = "location_point", gh = "dimensions['geohash']") =>
  `if(${pt}.1 = 0 AND ${pt}.2 = 0, if(notEmpty(${gh}), toFloat64(geohashDecode(${gh}).2), CAST(NULL AS Nullable(Float64))), toFloat64(${pt}.2))`;

const geoLon = (pt = "location_point", gh = "dimensions['geohash']") =>
  `if(${pt}.1 = 0 AND ${pt}.2 = 0, if(notEmpty(${gh}), toFloat64(geohashDecode(${gh}).1), CAST(NULL AS Nullable(Float64))), toFloat64(${pt}.1))`;

const propStr = (col, key) => `JSONExtractString(toString(${col}), '${key}')`;
const propNum = (col, key) =>
  `if(JSONHas(toString(${col}), '${key}'), JSONExtractFloat(toString(${col}), '${key}'), CAST(NULL AS Nullable(Float64)))`;

const dim = (name, type, description, extra = {}) => ({
  name,
  sql: name,
  type,
  title: name
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" "),
  description,
  ...extra,
});

const measure = (name, type, description, sql) => ({
  name,
  type,
  title: name
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" "),
  description,
  ...(sql ? { sql } : {}),
});

const DAY_JOIN_IS = {
  name: "day_archetypes",
  sql: "{CUBE}.day = {day_archetypes}.day AND {day_archetypes}.country_code = 'IS'",
  relationship: "many_to_one",
};

const eventCube = ({
  name,
  title,
  description,
  partition,
  collectionGids,
  refreshEvery = "1 hour",
  extraSelect = [],
  extraDimensions = [],
  extraMeasures = [],
}) => {
  const gids = Array.isArray(collectionGids) ? collectionGids : [collectionGids];
  const gidPredicate =
    gids.length === 1
      ? `collection_gid = toUUID('${gids[0]}')`
      : `collection_gid IN (${gids.map((g) => `toUUID('${g}')`).join(", ")})`;

  const extraSqlBlock = extraSelect.length ? `,\n        ${extraSelect.join(",\n        ")}` : "";

  return {
    name,
    title,
    description,
    refresh_key: { every: refreshEvery },
    sql: `
      SELECT
        toString(gid) AS event_id,
        name,
        description,
        toString(type) AS event_type,
        toString(sub_type) AS sub_type,
        date_from,
        date_to,
        toString(toDate(date_from)) AS day,
        all_day,
        toString(timezone) AS timezone,
        toString(status) AS status,
        is_cancelled != 0 AS is_cancelled,
        toString(country_code) AS country_code,
        arrayStringConcat(region, ', ') AS region,
        if(notEmpty(\`location.locality\`), \`location.locality\`[1], '') AS locality,
        if(notEmpty(\`location.postal_code\`), \`location.postal_code\`[1], '') AS postal_code,
        if(notEmpty(\`location.label\`), \`location.label\`[1], '') AS venue,
        coalesce(if(notEmpty(\`location.address\`), \`location.address\`[1], NULL), '') AS address,
        if(epicenter_known, toFloat64(epicenter.2), CAST(NULL AS Nullable(Float64))) AS lat,
        if(epicenter_known, toFloat64(epicenter.1), CAST(NULL AS Nullable(Float64))) AS lon,
        event_url,
        ticket_url,
        capacity${extraSqlBlock}
      FROM ql.calendar_events FINAL
      WHERE is_deleted = 0
        AND partition = '${partition}'
        AND access = 'Public'
        AND ${gidPredicate}
    `.trim(),
    joins: [
      {
        name: "day_archetypes",
        sql: "{CUBE}.day = {day_archetypes}.day AND {CUBE}.country_code = {day_archetypes}.country_code_alpha3",
        relationship: "many_to_one",
      },
    ],
    dimensions: [
      dim("event_id", "string", "Unique QuickLookup event UUID.", {
        primary_key: true,
        public: true,
      }),
      dim("name", "string", "Event title or headline."),
      dim("description", "string", "Longer event description when available."),
      dim("event_type", "string", "Primary event classification."),
      dim("sub_type", "string", "More specific event sub-type."),
      dim("date_from", "time", "Event start timestamp (UTC)."),
      dim("date_to", "time", "Event end timestamp (UTC)."),
      dim("day", "string", "Event start calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("all_day", "boolean", "Whether the event spans whole calendar days."),
      dim("timezone", "string", "IANA timezone identifier for local display."),
      dim("status", "string", "Publication or scheduling status (e.g. scheduled, cancelled)."),
      dim("is_cancelled", "boolean", "True when the event has been cancelled."),
      dim("country_code", "string", "ISO-3166 alpha-3 country code (e.g. ISL, USA, GBR)."),
      dim("region", "string", "Comma-separated region names covered by the event."),
      dim("locality", "string", "Primary city, town or locality."),
      dim("postal_code", "string", "Primary postal code when available."),
      dim("venue", "string", "Primary venue or site name."),
      dim("address", "string", "Primary street address."),
      dim("lat", "number", "WGS-84 latitude in degrees (NULL when location unknown)."),
      dim("lon", "number", "WGS-84 longitude in degrees (NULL when location unknown)."),
      dim("event_url", "string", "Canonical source or information URL."),
      dim("ticket_url", "string", "Ticket purchase URL when available."),
      dim("capacity", "number", "Reported venue or event capacity."),
      ...extraDimensions,
    ],
    measures: [
      measure("count", "count", "Number of matching events."),
      measure("total_capacity", "sum", "Sum of reported event capacities.", "capacity"),
      ...extraMeasures,
    ],
  };
};

const trafficIntervalCube = ({ name, title, description, seriesGid }) => ({
  name,
  title,
  description,
  refresh_key: { every: "15 minutes" },
  sql: `
    SELECT
      concat(
        toString(dp.entity_gid), ':',
        toString(dp.timestamp), ':',
        dp.dimensions['traffic_station_id'], ':',
        dp.dimensions['traffic_direction_id'], ':',
        dp.dimensions['traffic_direction_role'], ':',
        dp.dimensions['traffic_size_class']
      ) AS row_id,
      dp.timestamp AS timestamp,
      toString(toDate(dp.timestamp)) AS day,
      dp.dimensions['traffic_station_id'] AS station_id,
      dp.dimensions['traffic_station_name'] AS station_name,
      coalesce(sp.region, '') AS region,
      coalesce(sp.municipality, '') AS municipality,
      coalesce(sp.postal_code, '') AS postal_code,
      coalesce(sp.road_name, '') AS road_name,
      coalesce(sp.road_number, '') AS road_number,
      coalesce(sp.road_type, '') AS road_type,
      dp.dimensions['traffic_direction_id'] AS direction_id,
      dp.dimensions['traffic_direction_role'] AS direction_role,
      dp.dimensions['traffic_direction_text'] AS direction_text,
      dp.dimensions['traffic_size_class'] AS size_class,
      dp.dimensions['traffic_counter_type'] AS counter_type,
      ${safeLat("dp.location_point")} AS lat,
      ${safeLon("dp.location_point")} AS lon,
      ${numMetric("dp.metrics", "vehicle_count")} AS vehicle_count
    FROM (
      SELECT entity_gid, timestamp, location_point, dimensions, metrics
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('${seriesGid}')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY
        entity_gid,
        timestamp,
        dimensions['traffic_station_id'],
        dimensions['traffic_direction_id'],
        dimensions['traffic_direction_role'],
        dimensions['traffic_size_class']
    ) AS dp
    LEFT JOIN (
      SELECT station_id, region, municipality, postal_code, road_name, road_number, road_type
      FROM cst.traffic_station_places
      WHERE partition = '_open_'
    ) AS sp ON sp.station_id = dp.dimensions['traffic_station_id']
  `.trim(),
  joins: [
    {
      name: "traffic_stations",
      sql: "{CUBE}.station_id = {traffic_stations}.station_id",
      relationship: "many_to_one",
    },
    DAY_JOIN_IS,
  ],
  dimensions: [
    dim("row_id", "string", "Internal deduplicated row identifier.", { primary_key: true }),
    dim("timestamp", "time", "Interval start timestamp (UTC). Always filter by timestamp for fast queries."),
    dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
    dim("station_id", "string", "Vegagerðin traffic counter station identifier."),
    dim("station_name", "string", "Traffic counter station name."),
    dim("region", "string", "Icelandic region (landshluti)."),
    dim("municipality", "string", "Icelandic municipality (sveitarfélag)."),
    dim("postal_code", "string", "Station postal code."),
    dim("road_name", "string", "Road name."),
    dim("road_number", "string", "Road number (e.g. 1 for Ring Road)."),
    dim("road_type", "string", "Road classification."),
    dim("direction_id", "string", "Traffic flow direction identifier."),
    dim("direction_role", "string", "Direction aggregation role: 'combined', 'directional', or 'one_way_only'. Filter to avoid double-counting."),
    dim("direction_text", "string", "Human-readable travel direction."),
    dim("size_class", "string", "Vehicle length/size class ('all' for total traffic). Filter to avoid double-counting."),
    dim("counter_type", "string", "Counter hardware or reporting class."),
    dim("lat", "number", "Station WGS-84 latitude in degrees (NULL when unknown)."),
    dim("lon", "number", "Station WGS-84 longitude in degrees (NULL when unknown)."),
    dim("vehicle_count", "number", "Number of vehicles counted in the interval."),
  ],
  measures: [
    measure("count", "count", "Number of traffic observation rows."),
    measure("total_vehicles", "sum", "Sum of vehicle counts (filter direction_role and size_class).", "vehicle_count"),
    measure("avg_vehicles", "avg", "Average vehicle count per interval.", "vehicle_count"),
  ],
});

const CORE_CUBES = [
  // =========================================================================
  // 1. Traffic, Roads & Marine (Vegagerðin) + Construction (Vinnueftirlitið)
  // =========================================================================
  {
    name: "traffic_daily",
    title: "Daily Road Traffic",
    description:
      "Daily Vegagerðin road traffic counts across Iceland, deduplicated to prefer published daily totals. Filter direction_role = 'combined' and size_class = 'all' when summing totals.",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(
          toString(dp.entity_gid), ':',
          toString(dp.timestamp), ':',
          dp.dimensions['traffic_station_id'], ':',
          dp.dimensions['traffic_direction_id'], ':',
          dp.dimensions['traffic_direction_role'], ':',
          dp.dimensions['traffic_size_class']
        ) AS row_id,
        dp.timestamp AS timestamp,
        toString(toDate(dp.timestamp)) AS day,
        dp.dimensions['traffic_station_id'] AS station_id,
        dp.dimensions['traffic_station_name'] AS station_name,
        coalesce(sp.region, '') AS region,
        coalesce(sp.municipality, '') AS municipality,
        coalesce(sp.postal_code, '') AS postal_code,
        coalesce(sp.road_name, '') AS road_name,
        coalesce(sp.road_number, '') AS road_number,
        coalesce(sp.road_type, '') AS road_type,
        dp.dimensions['traffic_direction_id'] AS direction_id,
        dp.dimensions['traffic_direction_role'] AS direction_role,
        dp.dimensions['traffic_direction_text'] AS direction_text,
        dp.dimensions['traffic_size_class'] AS size_class,
        dp.dimensions['traffic_counter_type'] AS counter_type,
        dp.dimensions['traffic_count_basis'] AS count_basis,
        ${safeLat("dp.location_point")} AS lat,
        ${safeLon("dp.location_point")} AS lon,
        ${numMetric("dp.metrics", "vehicle_count")} AS vehicle_count,
        ${numMetric("dp.metrics", "reported_intervals")} AS reported_intervals,
        ${numMetric("dp.metrics", "expected_intervals")} AS expected_intervals
      FROM (
        SELECT entity_gid, timestamp, location_point, dimensions, metrics
        FROM cst.data_points
        WHERE partition = '_open_'
          AND access_type = 'Public'
          AND series_gid = toUUID('5cc76599-899a-506e-b317-2f872519cdd7')
        ORDER BY
          (dimensions['traffic_count_basis'] = 'published_daily') DESC,
          coalesce(as_of, created_at, timestamp) DESC,
          created_at DESC,
          signature DESC
        LIMIT 1 BY
          entity_gid,
          timestamp,
          dimensions['traffic_station_id'],
          dimensions['traffic_direction_id'],
          dimensions['traffic_direction_role'],
          dimensions['traffic_size_class']
      ) AS dp
      LEFT JOIN (
        SELECT station_id, region, municipality, postal_code, road_name, road_number, road_type
        FROM cst.traffic_station_places
        WHERE partition = '_open_'
      ) AS sp ON sp.station_id = dp.dimensions['traffic_station_id']
    `.trim(),
    joins: [
      {
        name: "traffic_stations",
        sql: "{CUBE}.station_id = {traffic_stations}.station_id",
        relationship: "many_to_one",
      },
      DAY_JOIN_IS,
    ],
    dimensions: [
      dim("row_id", "string", "Internal deduplicated row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Day start timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("station_id", "string", "Vegagerðin traffic counter station identifier."),
      dim("station_name", "string", "Traffic counter station name."),
      dim("region", "string", "Icelandic region (landshluti)."),
      dim("municipality", "string", "Icelandic municipality (sveitarfélag)."),
      dim("postal_code", "string", "Station postal code."),
      dim("road_name", "string", "Road name."),
      dim("road_number", "string", "Road number."),
      dim("road_type", "string", "Road classification."),
      dim("direction_id", "string", "Traffic flow direction identifier."),
      dim("direction_role", "string", "Direction aggregation role: 'combined', 'directional', or 'one_way_only'. Filter to avoid double-counting."),
      dim("direction_text", "string", "Human-readable travel direction."),
      dim("size_class", "string", "Vehicle size class ('all' for all vehicles). Filter to avoid double-counting."),
      dim("counter_type", "string", "Counter hardware or reporting class."),
      dim("count_basis", "string", "Whether the daily value is 'published_daily' or rolled up from intervals."),
      dim("lat", "number", "Station WGS-84 latitude in degrees (NULL when unknown)."),
      dim("lon", "number", "Station WGS-84 longitude in degrees (NULL when unknown)."),
      dim("vehicle_count", "number", "Total vehicles counted on the day."),
      dim("reported_intervals", "number", "Number of sub-daily intervals reported (NULL on published_daily rows)."),
      dim("expected_intervals", "number", "Expected sub-daily intervals in the day (NULL on published_daily rows)."),
    ],
    measures: [
      measure("count", "count", "Number of daily station rows."),
      measure("total_vehicles", "sum", "Sum of daily vehicle counts (filter direction_role and size_class).", "vehicle_count"),
      measure("avg_vehicles", "avg", "Average daily vehicle count.", "vehicle_count"),
    ],
  },
  trafficIntervalCube({
    name: "traffic_30m",
    title: "30-Minute Road Traffic",
    description:
      "30-minute Vegagerðin road traffic counts — the complete sub-daily grid covering all Icelandic counters (combining both 10-minute and 15-minute counter networks).",
    seriesGid: "20090216-4023-5265-b657-80f77f4e4d77",
  }),
  trafficIntervalCube({
    name: "traffic_15m",
    title: "15-Minute Road Traffic",
    description:
      "15-minute Vegagerðin road traffic counts (covers the 15-minute counter subset; use traffic_30m for full national sub-daily coverage).",
    seriesGid: "e635e0f5-7cb2-5112-9f68-b86840067a12",
  }),
  trafficIntervalCube({
    name: "traffic_10m",
    title: "10-Minute Road Traffic",
    description:
      "10-minute Vegagerðin road traffic counts (covers the 10-minute counter subset; use traffic_30m for full national sub-daily coverage).",
    seriesGid: "67f55250-4594-5d10-a7d5-8d48cfde9ca0",
  }),
  {
    name: "traffic_stations",
    title: "Traffic Counter Stations",
    description:
      "Reference directory of Vegagerðin traffic counter stations with region, municipality, postal code, and road metadata.",
    refresh_key: { every: "6 hours" },
    sql: `
      SELECT
        station_id,
        coalesce(region, '') AS region,
        coalesce(municipality, '') AS municipality,
        coalesce(postal_code, '') AS postal_code,
        coalesce(road_name, '') AS road_name,
        coalesce(road_number, '') AS road_number,
        coalesce(road_type, '') AS road_type
      FROM cst.traffic_station_places
      WHERE partition = '_open_'
    `.trim(),
    dimensions: [
      dim("station_id", "string", "Vegagerðin traffic counter station identifier.", {
        primary_key: true,
        public: true,
      }),
      dim("region", "string", "Icelandic region (landshluti)."),
      dim("municipality", "string", "Icelandic municipality (sveitarfélag)."),
      dim("postal_code", "string", "Station postal code."),
      dim("road_name", "string", "Road name."),
      dim("road_number", "string", "Road number."),
      dim("road_type", "string", "Road classification."),
    ],
    measures: [measure("count", "count", "Number of traffic stations.")],
  },
  {
    name: "road_conditions",
    title: "Road Conditions",
    description:
      "Daily Icelandic road surface conditions, closure flags, and mountain-road indicators (Vegagerðin).",
    refresh_key: { every: "15 minutes" },
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp)) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        toString(entity_gid) AS entity_id,
        toString(entity_gid_url) AS entity_url,
        ${propStr("properties", "AstandLysingEn")} AS condition_en,
        ${propStr("properties", "AstandLysing")} AS condition_is,
        ${propStr("properties", "AstandYfirbord")} AS surface_code,
        ${safeLat()} AS lat,
        ${safeLon()} AS lon,
        ${numMetric("metrics", "road_closed")} AS road_closed,
        ${numMetric("metrics", "road_mountain_only")} AS road_mountain_only
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('20f5fc66-b18d-51e1-ad16-f690c7bfdec3')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp
    `.trim(),
    joins: [DAY_JOIN_IS],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Observation date/timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("entity_id", "string", "Road segment entity UUID."),
      dim("entity_url", "string", "Canonical road segment entity URL."),
      dim("condition_en", "string", "English road condition summary (e.g. Easily passable, Slippery, Closed)."),
      dim("condition_is", "string", "Icelandic road condition summary."),
      dim("surface_code", "string", "Vegagerðin road surface status code."),
      dim("lat", "number", "Road segment WGS-84 latitude in degrees (NULL when unknown)."),
      dim("lon", "number", "Road segment WGS-84 longitude in degrees (NULL when unknown)."),
      dim("road_closed", "number", "1 when the road segment is closed, 0 otherwise."),
      dim("road_mountain_only", "number", "1 when passable for mountain/4x4 vehicles only, 0 otherwise."),
    ],
    measures: [measure("count", "count", "Number of road condition records.")],
  },
  {
    name: "road_notices",
    title: "Road Notices and Closures",
    description:
      "Daily Vegagerðin point road notices, closures, rockfall warnings, and roadworks with validity windows.",
    refresh_key: { every: "15 minutes" },
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp)) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        toString(entity_gid) AS entity_id,
        toString(entity_gid_url) AS entity_url,
        ${propStr("properties", "Astand")} AS notice_code,
        ${propStr("properties", "Lysing")} AS notice_text,
        ${propStr("properties", "GildirTil")} AS valid_until,
        if(location_point.1 = 0 AND location_point.2 = 0, ${propNum("properties", "Breidd")}, toFloat64(location_point.2)) AS lat,
        if(location_point.1 = 0 AND location_point.2 = 0, ${propNum("properties", "Lengd")}, toFloat64(location_point.1)) AS lon,
        ${numMetric("metrics", "road_all_traffic_banned")} AS all_traffic_banned
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('cb77c89c-56f3-5d67-97c0-bb5711238733')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp
    `.trim(),
    joins: [DAY_JOIN_IS],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Notice day timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("entity_id", "string", "Road notice entity UUID."),
      dim("entity_url", "string", "Canonical notice entity URL."),
      dim("notice_code", "string", "Vegagerðin hazard or closure code (e.g. GRJOTHRUN, LOKUN)."),
      dim("notice_text", "string", "Human-readable road notice description."),
      dim("valid_until", "string", "Expected notice expiry timestamp (ISO-8601) when specified."),
      dim("lat", "number", "Notice WGS-84 latitude in degrees."),
      dim("lon", "number", "Notice WGS-84 longitude in degrees."),
      dim("all_traffic_banned", "number", "1 when all traffic is prohibited at this point, 0 otherwise."),
    ],
    measures: [measure("count", "count", "Number of road notices.")],
  },
  {
    name: "sea_buoys",
    title: "Marine Sea Buoys",
    description:
      "Daily Vegagerðin marine buoy observations around Iceland (significant wave height, period, wavelength, depth).",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp)) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        toString(entity_gid) AS entity_id,
        ${propStr("properties", "NAFN")} AS buoy_name,
        ${propNum("properties", "DYPI")} AS water_depth_m,
        if(location_point.1 = 0 AND location_point.2 = 0, ${propNum("properties", "LAT")}, toFloat64(location_point.2)) AS lat,
        if(location_point.1 = 0 AND location_point.2 = 0, ${propNum("properties", "LON")}, toFloat64(location_point.1)) AS lon,
        ${numMetric("metrics", "buoy_wave_height_m")} AS wave_height_m,
        ${numMetric("metrics", "buoy_wave_period_s")} AS wave_period_s,
        ${numMetric("metrics", "buoy_wave_length_m")} AS wave_length_m
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('7d24f7bb-95f0-5467-9520-de7462d17580')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp
    `.trim(),
    joins: [DAY_JOIN_IS],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Observation date/timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("entity_id", "string", "Sea buoy entity UUID."),
      dim("buoy_name", "string", "Sea buoy station name (e.g. Grindavíkurdufl)."),
      dim("water_depth_m", "number", "Water depth at buoy mooring in meters."),
      dim("lat", "number", "Buoy WGS-84 latitude in degrees."),
      dim("lon", "number", "Buoy WGS-84 longitude in degrees."),
      dim("wave_height_m", "number", "Significant wave height in meters."),
      dim("wave_period_s", "number", "Peak wave period in seconds."),
      dim("wave_length_m", "number", "Mean wavelength in meters."),
    ],
    measures: [
      measure("count", "count", "Number of sea buoy observations."),
      measure("avg_wave_height_m", "avg", "Average significant wave height (m).", "wave_height_m"),
      measure("max_wave_height_m", "max", "Maximum significant wave height (m).", "wave_height_m"),
    ],
  },
  {
    name: "crane_inspections",
    title: "Crane Inspections (Construction)",
    description:
      "Monthly Icelandic tower crane inspections reported by Vinnueftirlitið (a leading construction activity indicator).",
    refresh_key: { every: "6 hours" },
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp)) AS row_id,
        timestamp,
        toString(entity_gid) AS entity_id,
        toString(entity_gid_url) AS entity_url,
        ${numMetric("metrics", "inspection_count")} AS inspection_count
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('2af923c4-6174-53c5-a9f8-9d32d5805dde')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp
    `.trim(),
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Month start timestamp (UTC)."),
      dim("entity_id", "string", "Reporting entity UUID."),
      dim("entity_url", "string", "Canonical entity URL."),
      dim("inspection_count", "number", "Number of crane inspections performed in the month."),
    ],
    measures: [
      measure("count", "count", "Number of monthly crane inspection records."),
      measure("total_inspections", "sum", "Sum of crane inspections.", "inspection_count"),
    ],
  },

  // =========================================================================
  // 2. Fuel & Hospitality
  // =========================================================================
  {
    name: "fuel_prices",
    title: "Fuel Prices",
    description:
      "Daily retail fuel prices by station, brand and fuel type in Iceland (ISK per liter). discount_price is NULL when no loyalty discount applies.",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['fuel_type']
        ) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['company'] AS company,
        dimensions['company_name'] AS company_name,
        dimensions['station_name'] AS station_name,
        dimensions['fuel_type'] AS fuel_type,
        ${safeLat()} AS lat,
        ${safeLon()} AS lon,
        ${numMetric("metrics", "price")} AS price,
        ${numMetric("metrics", "discount_price")} AS discount_price
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('0d9da0da-4324-5898-bc12-dae8e30b07a3')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['fuel_type']
    `.trim(),
    joins: [DAY_JOIN_IS],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Price observation date (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("company", "string", "Short fuel retailer slug (e.g. n1, ob, orkan, atlantsolia)."),
      dim("company_name", "string", "Fuel retailer display name."),
      dim("station_name", "string", "Fuel station name and location."),
      dim("fuel_type", "string", "Fuel type (e.g. bensin95, diesel)."),
      dim("lat", "number", "Station WGS-84 latitude in degrees (NULL when unknown)."),
      dim("lon", "number", "Station WGS-84 longitude in degrees (NULL when unknown)."),
      dim("price", "number", "Pump list price in ISK per liter."),
      dim("discount_price", "number", "Discounted loyalty price in ISK per liter (NULL when unavailable)."),
    ],
    measures: [
      measure("count", "count", "Number of fuel price rows."),
      measure("avg_price", "avg", "Average pump price (ISK/L).", "price"),
      measure("min_price", "min", "Lowest pump price (ISK/L).", "price"),
      measure("max_price", "max", "Highest pump price (ISK/L).", "price"),
      measure("avg_discount_price", "avg", "Average loyalty discount price (ISK/L, excluding NULLs).", "discount_price"),
    ],
  },
  {
    name: "hotel_statistics",
    title: "Hotel Statistics",
    description:
      "Monthly Icelandic hotel capacity (hotels, rooms, beds) and domestic/foreign guest nights by region (Statistics Iceland).",
    refresh_key: { every: "6 hours" },
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp), ':', dimensions['region_name']) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['region_name'] AS region_name,
        ${numMetric("metrics", "hotels_count")} AS hotels_count,
        ${numMetric("metrics", "rooms_count")} AS rooms_count,
        ${numMetric("metrics", "beds_count")} AS beds_count,
        ${numMetric("metrics", "guest_nights_total")} AS guest_nights_total,
        ${numMetric("metrics", "guest_nights_domestic")} AS guest_nights_domestic,
        ${numMetric("metrics", "guest_nights_foreign")} AS guest_nights_foreign
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('ce8e9c9e-de84-5006-ae4b-1c6dc5185ac4')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['region_name']
    `.trim(),
    joins: [DAY_JOIN_IS],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Month start timestamp (UTC)."),
      dim("day", "string", "Month start date (YYYY-MM-DD, UTC) for joins."),
      dim("region_name", "string", "Icelandic tourism region name."),
      dim("hotels_count", "number", "Number of operating hotels."),
      dim("rooms_count", "number", "Total available hotel rooms."),
      dim("beds_count", "number", "Total available hotel beds."),
      dim("guest_nights_total", "number", "Total overnight guest stays."),
      dim("guest_nights_domestic", "number", "Overnight stays by Icelandic residents."),
      dim("guest_nights_foreign", "number", "Overnight stays by foreign visitors."),
    ],
    measures: [
      measure("count", "count", "Number of monthly region records."),
      measure("total_guest_nights", "sum", "Sum of total guest nights.", "guest_nights_total"),
      measure("total_foreign_guest_nights", "sum", "Sum of foreign guest nights.", "guest_nights_foreign"),
      measure("total_domestic_guest_nights", "sum", "Sum of domestic guest nights.", "guest_nights_domestic"),
    ],
  },

  // =========================================================================
  // 3. Weather, Daylight & Context
  // =========================================================================
  {
    name: "weather_observations",
    title: "Weather Observations Archive",
    description:
      "Complete 1979–present + 5-day forecast station weather archive (~1,120 stations from ql.weather). Filter by timestamp and station_id or geohash for sub-second responses.",
    refresh_key: { every: "15 minutes" },
    sql: `
      SELECT
        toString(gid) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        toString(station_id) AS station_id,
        toString(country_code) AS country_code,
        geohash,
        toString(h3_7) AS h3_7,
        toString(period) AS period,
        toInt32(lead_time) AS lead_time,
        toString(source) AS source,
        if(location.1 = 0 AND location.2 = 0, CAST(NULL AS Nullable(Float64)), toFloat64(location.2)) AS lat,
        if(location.1 = 0 AND location.2 = 0, CAST(NULL AS Nullable(Float64)), toFloat64(location.1)) AS lon,
        toFloat64(temperature) AS temperature,
        toFloat64(feels_like) AS feels_like,
        toFloat64(wind_speed) AS wind_speed,
        toFloat64(wind_gust) AS wind_gust,
        toFloat64(wind_direction) AS wind_direction,
        toFloat64(precipitation_rain) AS precipitation_rain,
        toFloat64(precipitation_snow) AS precipitation_snow,
        toFloat64(cloud_cover) AS cloud_cover,
        toFloat64(humidity) AS humidity,
        toFloat64(pressure) AS pressure,
        toFloat64(visibility) AS visibility,
        toFloat64(dew_point) AS dew_point
      FROM ql.weather FINAL
    `.trim(),
    joins: [
      {
        name: "day_archetypes",
        sql: "{CUBE}.day = {day_archetypes}.day AND {CUBE}.country_code = {day_archetypes}.country_code_alpha3",
        relationship: "many_to_one",
      },
    ],
    dimensions: [
      dim("row_id", "string", "Unique weather observation UUID.", { primary_key: true }),
      dim("timestamp", "time", "Observation or forecast valid timestamp (UTC). Always filter by timestamp."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("station_id", "string", "Weather station identifier."),
      dim("country_code", "string", "ISO-3166 alpha-3 country code (e.g. ISL)."),
      dim("geohash", "string", "Precision-6 geohash of the weather station."),
      dim("h3_7", "string", "H3 hexagonal spatial index at resolution 7 (~5 km)."),
      dim("period", "string", "Reporting cadence (ISO-8601 duration, e.g. PT1H, P1D)."),
      dim("lead_time", "number", "Forecast lead time in hours (0 = observed measurement)."),
      dim("source", "string", "Upstream weather provider/source."),
      dim("lat", "number", "Station WGS-84 latitude in degrees."),
      dim("lon", "number", "Station WGS-84 longitude in degrees."),
      dim("temperature", "number", "Air temperature in °C."),
      dim("feels_like", "number", "Apparent feels-like temperature in °C."),
      dim("wind_speed", "number", "Sustained wind speed in m/s."),
      dim("wind_gust", "number", "Wind gust speed in m/s."),
      dim("wind_direction", "number", "Wind bearing in degrees (0–360)."),
      dim("precipitation_rain", "number", "Rainfall in mm."),
      dim("precipitation_snow", "number", "Snowfall in mm."),
      dim("cloud_cover", "number", "Cloud cover percentage (0–100)."),
      dim("humidity", "number", "Relative humidity percentage (0–100)."),
      dim("pressure", "number", "Sea-level atmospheric pressure in hPa."),
      dim("visibility", "number", "Horizontal visibility in meters."),
      dim("dew_point", "number", "Dew point temperature in °C."),
    ],
    measures: [
      measure("count", "count", "Number of weather observation rows."),
      measure("avg_temperature", "avg", "Average air temperature (°C).", "temperature"),
      measure("avg_wind_speed", "avg", "Average wind speed (m/s).", "wind_speed"),
      measure("total_rain", "sum", "Total rainfall (mm).", "precipitation_rain"),
      measure("total_snow", "sum", "Total snowfall (mm).", "precipitation_snow"),
    ],
  },
  {
    name: "weather",
    title: "Weather Metrics (Daily & Part-of-Day)",
    description:
      "Observed and forecast weather metrics by geohash and part of day (day_part + summary_method). Filter both day_part and summary_method to avoid mixing hourly and summary rows. For the full raw 1979–present station archive, query weather_observations.",
    refresh_key: { every: "15 minutes" },
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['geohash'], ':',
          dimensions['period'], ':',
          dimensions['summarize']
        ) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['geohash'] AS geohash,
        dimensions['period'] AS day_part,
        dimensions['summarize'] AS summary_method,
        dimensions['timezone'] AS timezone,
        ${propStr("properties", "value_basis")} AS value_basis,
        ${numMetric("metrics", "forecast_lead_h")} AS forecast_lead_h,
        ${geoLat()} AS lat,
        ${geoLon()} AS lon,
        ${numMetric("metrics", "temperature")} AS temperature,
        ${numMetric("metrics", "feels_like")} AS feels_like,
        ${numMetric("metrics", "wind_speed")} AS wind_speed,
        ${numMetric("metrics", "wind_gust")} AS wind_gust,
        ${numMetric("metrics", "wind_direction")} AS wind_direction,
        ${numMetric("metrics", "precipitation_rain")} AS precipitation_rain,
        ${numMetric("metrics", "precipitation_snow")} AS precipitation_snow,
        ${numMetric("metrics", "cloud_cover")} AS cloud_cover,
        ${numMetric("metrics", "humidity")} AS humidity,
        ${numMetric("metrics", "pressure")} AS pressure,
        ${numMetric("metrics", "visibility")} AS visibility,
        ${numMetric("metrics", "dew_point")} AS dew_point
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('84451ef4-fc70-5f94-8346-01e2a5e69f5f')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY
        entity_gid,
        timestamp,
        dimensions['geohash'],
        dimensions['period'],
        dimensions['summarize']
    `.trim(),
    joins: [
      {
        name: "daylight",
        sql: "{CUBE}.day = {daylight}.day AND {CUBE}.geohash = {daylight}.geohash",
        relationship: "many_to_one",
      },
      {
        name: "day_archetypes",
        sql: "{CUBE}.day = {day_archetypes}.day AND {CUBE}.geohash = {day_archetypes}.geohash",
        relationship: "many_to_one",
      },
    ],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Observation or summary timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("geohash", "string", "Location geohash."),
      dim("day_part", "string", "Part of day: 'All', 'Morning', 'Noon', or 'Evening'."),
      dim("summary_method", "string", "Aggregation method: 'No' (hourly), 'avg', 'min', or 'max'."),
      dim("timezone", "string", "IANA timezone identifier."),
      dim("value_basis", "string", "Whether the row is observed or forecast when recorded."),
      dim("forecast_lead_h", "number", "Forecast lead time in hours (NULL for observations)."),
      dim("lat", "number", "WGS-84 latitude in degrees (decoded from geohash when station point unset)."),
      dim("lon", "number", "WGS-84 longitude in degrees (decoded from geohash when station point unset)."),
      dim("temperature", "number", "Air temperature in °C."),
      dim("feels_like", "number", "Feels-like temperature in °C."),
      dim("wind_speed", "number", "Wind speed in m/s."),
      dim("wind_gust", "number", "Wind gust speed in m/s."),
      dim("wind_direction", "number", "Wind direction in degrees (0–360)."),
      dim("precipitation_rain", "number", "Rainfall in mm."),
      dim("precipitation_snow", "number", "Snowfall in mm."),
      dim("cloud_cover", "number", "Cloud cover percentage (0–100)."),
      dim("humidity", "number", "Relative humidity percentage (0–100)."),
      dim("pressure", "number", "Atmospheric pressure in hPa."),
      dim("visibility", "number", "Visibility in meters."),
      dim("dew_point", "number", "Dew point temperature in °C."),
    ],
    measures: [
      measure("count", "count", "Number of weather rows."),
      measure("avg_temperature", "avg", "Average temperature (°C).", "temperature"),
      measure("avg_wind_speed", "avg", "Average wind speed (m/s).", "wind_speed"),
      measure("total_rain", "sum", "Total rainfall (mm).", "precipitation_rain"),
      measure("total_snow", "sum", "Total snowfall (mm).", "precipitation_snow"),
    ],
  },
  {
    name: "weather_archetypes",
    title: "Weather Archetypes and Comfort",
    description:
      "Daily weather comfort indices (TCI, HCI urban/beach), temperature deviation from normal, and extreme-weather flags by geohash and part of day.",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['geohash'], ':',
          dimensions['period']
        ) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['geohash'] AS geohash,
        dimensions['period'] AS day_part,
        dimensions['timezone'] AS timezone,
        ${geoLat()} AS lat,
        ${geoLon()} AS lon,
        ${numMetric("metrics", "temperature")} AS temperature,
        ${numMetric("metrics", "temp_deviation")} AS temp_deviation,
        ${numMetric("metrics", "tci")} AS tci,
        ${numMetric("metrics", "hci_urban")} AS hci_urban,
        ${numMetric("metrics", "hci_beach")} AS hci_beach,
        ${numMetric("metrics", "heavy_rain")} AS heavy_rain,
        ${numMetric("metrics", "heavy_snow")} AS heavy_snow,
        ${numMetric("metrics", "heavy_wind")} AS heavy_wind,
        ${numMetric("metrics", "extreme_cold")} AS extreme_cold,
        ${numMetric("metrics", "extreme_heat")} AS extreme_heat,
        ${numMetric("metrics", "quality_score")} AS quality_score
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('83780652-2482-5902-921b-d6fc1ec7a50e')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['geohash'], dimensions['period']
    `.trim(),
    joins: [
      {
        name: "day_archetypes",
        sql: "{CUBE}.day = {day_archetypes}.day AND {CUBE}.geohash = {day_archetypes}.geohash",
        relationship: "many_to_one",
      },
    ],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Day timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("geohash", "string", "Location geohash."),
      dim("day_part", "string", "Part of day: 'All', 'Morning', 'Noon', or 'Evening'."),
      dim("timezone", "string", "IANA timezone identifier."),
      dim("lat", "number", "WGS-84 latitude in degrees."),
      dim("lon", "number", "WGS-84 longitude in degrees."),
      dim("temperature", "number", "Mean temperature in °C."),
      dim("temp_deviation", "number", "Deviation from historical temperature normal in °C."),
      dim("tci", "number", "Tourism Climate Index (0–100)."),
      dim("hci_urban", "number", "Holiday Climate Index — urban sightseeing (0–100)."),
      dim("hci_beach", "number", "Holiday Climate Index — coastal/beach (0–100)."),
      dim("heavy_rain", "number", "Heavy rain indicator (1 = yes, 0 = no)."),
      dim("heavy_snow", "number", "Heavy snow indicator (1 = yes, 0 = no)."),
      dim("heavy_wind", "number", "High wind indicator (1 = yes, 0 = no)."),
      dim("extreme_cold", "number", "Extreme cold indicator (1 = yes, 0 = no)."),
      dim("extreme_heat", "number", "Extreme heat indicator (1 = yes, 0 = no)."),
      dim("quality_score", "number", "Overall weather data quality score."),
    ],
    measures: [
      measure("count", "count", "Number of weather archetype rows."),
      measure("avg_tci", "avg", "Average Tourism Climate Index.", "tci"),
      measure("avg_hci_urban", "avg", "Average urban Holiday Climate Index.", "hci_urban"),
    ],
  },
  {
    name: "weather_normals",
    title: "Weather Normals",
    description:
      "Multi-year historical weather averages and medians by geohash, part of day, and calendar day.",
    refresh_key: { every: "6 hours" },
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['geohash'], ':',
          dimensions['period'], ':',
          dimensions['years']
        ) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['geohash'] AS geohash,
        dimensions['period'] AS day_part,
        dimensions['years'] AS baseline_years,
        dimensions['window_size'] AS window_size,
        ${geoLat()} AS lat,
        ${geoLon()} AS lon,
        ${numMetric("metrics", "temperature_avg")} AS temperature_avg,
        ${numMetric("metrics", "temperature_p50")} AS temperature_p50,
        ${numMetric("metrics", "wind_speed_avg")} AS wind_speed_avg,
        ${numMetric("metrics", "wind_speed_p50")} AS wind_speed_p50,
        ${numMetric("metrics", "precipitation_rain_avg")} AS precipitation_rain_avg,
        ${numMetric("metrics", "precipitation_snow_avg")} AS precipitation_snow_avg,
        ${numMetric("metrics", "cloud_cover_avg")} AS cloud_cover_avg,
        ${numMetric("metrics", "humidity_avg")} AS humidity_avg,
        ${numMetric("metrics", "pressure_avg")} AS pressure_avg
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('d0ca656f-51e8-5478-8a6c-3932aefd81ab')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY
        entity_gid,
        timestamp,
        dimensions['geohash'],
        dimensions['period'],
        dimensions['years']
    `.trim(),
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Calendar day timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC)."),
      dim("geohash", "string", "Location geohash."),
      dim("day_part", "string", "Part of day: 'All', 'Morning', 'Noon', or 'Evening'."),
      dim("baseline_years", "string", "Number of historical baseline years averaged."),
      dim("window_size", "string", "Rolling calendar window size in days."),
      dim("lat", "number", "WGS-84 latitude in degrees."),
      dim("lon", "number", "WGS-84 longitude in degrees."),
      dim("temperature_avg", "number", "Historical mean air temperature in °C."),
      dim("temperature_p50", "number", "Historical median air temperature in °C."),
      dim("wind_speed_avg", "number", "Historical mean wind speed in m/s."),
      dim("wind_speed_p50", "number", "Historical median wind speed in m/s."),
      dim("precipitation_rain_avg", "number", "Historical mean rainfall in mm."),
      dim("precipitation_snow_avg", "number", "Historical mean snowfall in mm."),
      dim("cloud_cover_avg", "number", "Historical mean cloud cover (%)."),
      dim("humidity_avg", "number", "Historical mean relative humidity (%)."),
      dim("pressure_avg", "number", "Historical mean atmospheric pressure (hPa)."),
    ],
    measures: [measure("count", "count", "Number of weather normal rows.")],
  },
  {
    name: "daylight",
    title: "Daylight and Celestial",
    description:
      "Daily sunrise, sunset, civil twilight, day length, and lunar phase by geohash.",
    refresh_key: { every: "6 hours" },
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp), ':', dimensions['geohash']) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['geohash'] AS geohash,
        dimensions['timezone'] AS timezone,
        dimensions['sunrise'] AS sunrise,
        dimensions['sunset'] AS sunset,
        dimensions['solar_noon'] AS solar_noon,
        dimensions['civil_dawn'] AS civil_dawn,
        dimensions['civil_dusk'] AS civil_dusk,
        dimensions['moon_phase_name'] AS moon_phase_name,
        ${geoLat()} AS lat,
        ${geoLon()} AS lon,
        ${numMetric("metrics", "day_length_hours")} AS day_length_hours,
        ${numMetric("metrics", "moon_fraction")} AS moon_fraction,
        ${numMetric("metrics", "moon_phase_value")} AS moon_phase_value
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('de8bcfe7-d57c-5648-a867-99885763e786')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['geohash']
    `.trim(),
    joins: [
      {
        name: "day_archetypes",
        sql: "{CUBE}.day = {day_archetypes}.day AND {CUBE}.geohash = {day_archetypes}.geohash",
        relationship: "many_to_one",
      },
    ],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Day start timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("geohash", "string", "Location geohash."),
      dim("timezone", "string", "IANA timezone identifier."),
      dim("sunrise", "string", "Sunrise timestamp (ISO-8601)."),
      dim("sunset", "string", "Sunset timestamp (ISO-8601)."),
      dim("solar_noon", "string", "Solar noon timestamp (ISO-8601)."),
      dim("civil_dawn", "string", "Civil dawn timestamp (ISO-8601)."),
      dim("civil_dusk", "string", "Civil dusk timestamp (ISO-8601)."),
      dim("moon_phase_name", "string", "Named lunar phase (e.g. Full Moon, Waxing Gibbous)."),
      dim("lat", "number", "WGS-84 latitude in degrees."),
      dim("lon", "number", "WGS-84 longitude in degrees."),
      dim("day_length_hours", "number", "Total daylight duration in hours."),
      dim("moon_fraction", "number", "Illuminated fraction of the lunar disc (0–1)."),
      dim("moon_phase_value", "number", "Lunar cycle position (0–1)."),
    ],
    measures: [
      measure("count", "count", "Number of daylight rows."),
      measure("avg_day_length_hours", "avg", "Average daylight length (hours).", "day_length_hours"),
    ],
  },
  {
    name: "day_archetypes",
    title: "Day Archetypes",
    description:
      "Calendar day classifications: workday, weekend, holiday, season, daylight, and streak features. Joins cleanly with traffic, weather, fuel, and event tables.",
    refresh_key: { every: "6 hours" },
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['country_code'], ':',
          dimensions['geohash']
        ) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['country_code'] AS country_code,
        if(
          notEmpty(dimensions['country_code_alpha3']),
          dimensions['country_code_alpha3'],
          multiIf(
            dimensions['country_code'] = 'IS', 'ISL',
            dimensions['country_code'] = 'US', 'USA',
            dimensions['country_code'] = 'GB', 'GBR',
            dimensions['country_code'] = 'DK', 'DNK',
            dimensions['country_code'] = 'NO', 'NOR',
            dimensions['country_code'] = 'SE', 'SWE',
            dimensions['country_code'] = 'DE', 'DEU',
            dimensions['country_code'] = 'FR', 'FRA',
            dimensions['country_code']
          )
        ) AS country_code_alpha3,
        dimensions['geohash'] AS geohash,
        dimensions['day_name'] AS day_name,
        dimensions['month_name'] AS month_name,
        dimensions['season_name'] AS season_name,
        dimensions['archetype_marker'] AS archetype_marker,
        ${boolDim("dimensions", "is_workday")} AS is_workday,
        ${boolDim("dimensions", "is_weekend")} AS is_weekend,
        ${boolDim("dimensions", "is_holiday")} AS is_holiday,
        ${boolDim("dimensions", "is_vacation_season")} AS is_vacation_season,
        ${boolDim("dimensions", "is_observance")} AS is_observance,
        ${boolDim("dimensions", "is_closed")} AS is_closed,
        ${numMetric("metrics", "day_of_week")} AS day_of_week,
        ${numMetric("metrics", "day_of_month")} AS day_of_month,
        ${numMetric("metrics", "day_of_year")} AS day_of_year,
        ${numMetric("metrics", "week_of_year")} AS week_of_year,
        ${numMetric("metrics", "month_of_year")} AS month_of_year,
        ${numMetric("metrics", "hours_of_daylight")} AS hours_of_daylight,
        ${numMetric("metrics", "workday_streak")} AS workday_streak,
        ${numMetric("metrics", "non_workday_streak")} AS non_workday_streak
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('ea04a69d-de7e-5f27-ae69-62323c6d79ed')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['country_code'], dimensions['geohash']
    `.trim(),
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Day start timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("country_code", "string", "ISO-3166 alpha-2 country code (e.g. IS)."),
      dim("country_code_alpha3", "string", "ISO-3166 alpha-3 country code (e.g. ISL) for joining with event tables."),
      dim("geohash", "string", "Location geohash."),
      dim("day_name", "string", "English weekday name (Monday–Sunday)."),
      dim("month_name", "string", "English month name."),
      dim("season_name", "string", "Season label (Winter, Spring, Summer, Autumn)."),
      dim("archetype_marker", "string", "Combined calendar archetype marker."),
      dim("is_workday", "boolean", "True on standard business workdays."),
      dim("is_weekend", "boolean", "True on Saturday/Sunday."),
      dim("is_holiday", "boolean", "True on public holidays."),
      dim("is_vacation_season", "boolean", "True during major holiday/vacation periods."),
      dim("is_observance", "boolean", "True on cultural/commercial observances."),
      dim("is_closed", "boolean", "True on statutory closure days."),
      dim("day_of_week", "number", "Day of week index (1 = Monday, 7 = Sunday)."),
      dim("day_of_month", "number", "Day of month (1–31)."),
      dim("day_of_year", "number", "Day of year (1–366)."),
      dim("week_of_year", "number", "ISO week number (1–53)."),
      dim("month_of_year", "number", "Month number (1–12)."),
      dim("hours_of_daylight", "number", "Daylight duration in hours."),
      dim("workday_streak", "number", "Consecutive workday count including this day."),
      dim("non_workday_streak", "number", "Consecutive weekend/holiday count including this day."),
    ],
    measures: [measure("count", "count", "Number of calendar day rows.")],
  },
  {
    name: "activity_ratings",
    title: "Activity Ratings",
    description:
      "Daily outdoor and indoor activity suitability scores based on weather, daylight, and venue availability.",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['geohash'], ':',
          dimensions['activity']
        ) AS row_id,
        timestamp,
        toString(toDate(timestamp)) AS day,
        dimensions['geohash'] AS geohash,
        dimensions['activity'] AS activity,
        dimensions['timezone'] AS timezone,
        ${propStr("properties", "activity_group")} AS activity_group,
        ${propStr("properties", "band")} AS rating_band,
        ${propStr("properties", "limiting_factor")} AS limiting_factor,
        ${geoLat()} AS lat,
        ${geoLon()} AS lon,
        ${numMetric("metrics", "rating")} AS rating,
        ${numMetric("metrics", "fit_score")} AS fit_score,
        ${numMetric("metrics", "weather_score")} AS weather_score,
        ${numMetric("metrics", "daylight_score")} AS daylight_score,
        ${numMetric("metrics", "service_score")} AS service_score
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('5c120b29-b563-567f-99fa-deb61a39e9f7')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['geohash'], dimensions['activity']
    `.trim(),
    joins: [
      {
        name: "weather",
        sql: "{CUBE}.day = {weather}.day AND {CUBE}.geohash = {weather}.geohash AND {weather}.day_part = 'All' AND {weather}.summary_method = 'avg'",
        relationship: "many_to_one",
      },
      {
        name: "daylight",
        sql: "{CUBE}.day = {daylight}.day AND {CUBE}.geohash = {daylight}.geohash",
        relationship: "many_to_one",
      },
      {
        name: "day_archetypes",
        sql: "{CUBE}.day = {day_archetypes}.day AND {CUBE}.geohash = {day_archetypes}.geohash",
        relationship: "many_to_one",
      },
    ],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Rating day timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("geohash", "string", "Location geohash."),
      dim("activity", "string", "Activity identifier (e.g. hiking, swimming, cycling, golf)."),
      dim("timezone", "string", "IANA timezone identifier."),
      dim("activity_group", "string", "Broader activity category."),
      dim("rating_band", "string", "Qualitative suitability band."),
      dim("limiting_factor", "string", "Primary factor reducing the rating (e.g. wind, rain, darkness)."),
      dim("lat", "number", "WGS-84 latitude in degrees."),
      dim("lon", "number", "WGS-84 longitude in degrees."),
      dim("rating", "number", "Overall suitability score (0–100)."),
      dim("fit_score", "number", "Weather & daylight fit sub-score."),
      dim("weather_score", "number", "Weather sub-score."),
      dim("daylight_score", "number", "Daylight availability sub-score."),
      dim("service_score", "number", "Venue/facility availability sub-score."),
    ],
    measures: [
      measure("count", "count", "Number of activity rating rows."),
      measure("avg_rating", "avg", "Average suitability rating.", "rating"),
    ],
  },

  // =========================================================================
  // 4. Events & Calendars (with domain-specific columns + public event_id)
  // =========================================================================
  eventCube({
    name: "holidays",
    title: "Public Holidays",
    description: "Public holidays and observances in Iceland and worldwide (ISO-3166 alpha-3 country_code, e.g. 'ISL').",
    partition: "_open_",
    collectionGids: "037fd8b2-2918-5e6e-8bee-13bfec7c8326",
    refreshEvery: "6 hours",
    extraSelect: [`${boolDim("dimensions", "from_noon")} AS from_noon`],
    extraDimensions: [
      dim("from_noon", "boolean", "True for half-day holidays starting at noon (e.g. Christmas Eve / New Year's Eve)."),
    ],
  }),
  eventCube({
    name: "school_calendars",
    title: "School Calendars",
    description: "Icelandic school calendars: days off, reduced days, exams, and term dates by school level and municipality.",
    partition: "snjallgogn.is",
    collectionGids: "6fdcc15e-235b-5703-a212-452a0b1acba9",
    refreshEvery: "6 hours",
    extraSelect: [
      "dimensions['school_level'] AS school_level",
      "dimensions['school_year'] AS school_year",
      "dimensions['municipality'] AS municipality",
      `${propStr("properties", "attendance")} AS attendance`,
    ],
    extraDimensions: [
      dim("school_level", "string", "School level (e.g. preschool, primary, upper_secondary)."),
      dim("school_year", "string", "Academic school year (e.g. 2026-2027)."),
      dim("municipality", "string", "Icelandic municipality of the school."),
      dim("attendance", "string", "Attendance impact (e.g. closed, reduced, exam)."),
    ],
  }),
  eventCube({
    name: "demand_drivers",
    title: "Icelandic Demand Drivers",
    description: "Icelandic market calendar: retail promotions, tournaments, festivals, and commercial observances.",
    partition: "snjallgogn.is",
    collectionGids: "1fbab555-7a02-5982-8e14-a78aea274662",
    refreshEvery: "6 hours",
    extraSelect: [
      "dimensions['record_kind'] AS record_kind",
      "dimensions['model_layer'] AS model_layer",
      "dimensions['research_group'] AS research_group",
      `${propStr("properties", "event_variant")} AS event_variant`,
    ],
    extraDimensions: [
      dim("record_kind", "string", "Demand driver record classification."),
      dim("model_layer", "string", "Calendar modeling layer."),
      dim("research_group", "string", "Thematic demand driver group."),
      dim("event_variant", "string", "Specific sub-variant or cohort."),
    ],
  }),
  eventCube({
    name: "natural_hazards",
    title: "Natural Hazards",
    description: "Earthquakes, weather warnings (yellow/orange/red), and volcanic hazard alerts in Iceland. Filter latest = 'true' to exclude superseded alerts.",
    partition: "_open_",
    collectionGids: "2dae4ade-d788-520d-a548-75769fe8fb7d",
    refreshEvery: "15 minutes",
    extraSelect: [
      "dimensions['source'] AS source",
      "dimensions['level'] AS level",
      "dimensions['severity'] AS severity",
      "dimensions['certainty'] AS certainty",
      "dimensions['urgency'] AS urgency",
      "dimensions['region_code'] AS region_code",
      `${boolDim("dimensions", "latest")} AS latest`,
      `${numMetric("metrics", "magnitude")} AS magnitude`,
      `${numMetric("metrics", "depth_km")} AS depth_km`,
      `${numMetric("metrics", "lead_hours")} AS lead_hours`,
      `${numMetric("metrics", "duration_hours")} AS duration_hours`,
    ],
    extraDimensions: [
      dim("source", "string", "Issuing authority or hazard feed source."),
      dim("level", "string", "Alert color level (yellow, orange, red)."),
      dim("severity", "string", "CAP alert severity (Minor, Moderate, Severe, Extreme)."),
      dim("certainty", "string", "CAP alert certainty."),
      dim("urgency", "string", "CAP alert urgency."),
      dim("region_code", "string", "IMO forecast region code (e.g. IS011 = Central Highlands)."),
      dim("latest", "boolean", "True for the latest active revision of an alert episode."),
      dim("magnitude", "number", "Earthquake magnitude (NULL for weather alerts)."),
      dim("depth_km", "number", "Earthquake hypocenter depth in km."),
      dim("lead_hours", "number", "Warning lead time in hours before onset."),
      dim("duration_hours", "number", "Alert duration in hours."),
    ],
    extraMeasures: [
      measure("max_magnitude", "max", "Maximum earthquake magnitude.", "magnitude"),
    ],
  }),
  eventCube({
    name: "flights",
    title: "Flights (KEF)",
    description: "Keflavík International Airport (KEF) scheduled and actual flight arrivals and departures with airline and delay details.",
    partition: "_open_",
    collectionGids: "40c34e2e-4a93-5fd5-b8f1-3829b6b16def",
    refreshEvery: "15 minutes",
    extraSelect: [
      "dimensions['airline'] AS airline",
      "dimensions['airline_iata'] AS airline_iata",
      "dimensions['flight_number'] AS flight_number",
      "dimensions['airport_iata'] AS airport_iata",
      "dimensions['other_airport'] AS other_airport",
      "dimensions['other_airport_iata'] AS other_airport_iata",
      "dimensions['aircraft_type'] AS aircraft_type",
      "dimensions['flight_phase'] AS flight_phase",
      `${numMetric("metrics", "delay_minutes")} AS delay_minutes`,
    ],
    extraDimensions: [
      dim("airline", "string", "Operating airline name."),
      dim("airline_iata", "string", "Two-letter IATA airline code (e.g. FI)."),
      dim("flight_number", "string", "Flight number (e.g. FI451)."),
      dim("airport_iata", "string", "Home airport IATA code (KEF)."),
      dim("other_airport", "string", "Origin (arrivals) or destination (departures) airport name."),
      dim("other_airport_iata", "string", "Origin/destination IATA airport code."),
      dim("aircraft_type", "string", "Aircraft type code."),
      dim("flight_phase", "string", "Arrival or departure phase."),
      dim("delay_minutes", "number", "Reported delay relative to schedule in minutes."),
    ],
    extraMeasures: [
      measure("avg_delay_minutes", "avg", "Average flight delay in minutes.", "delay_minutes"),
    ],
  }),
  eventCube({
    name: "cruise_ships",
    title: "Cruise Ships",
    description: "Scheduled cruise ship port calls across Icelandic ports with passenger and crew counts.",
    partition: "_open_",
    collectionGids: "ecbd451a-3b31-5c01-964f-868cf28115f7",
    refreshEvery: "1 hour",
    extraSelect: [
      `${propStr("properties", "portLocode")} AS port_locode`,
      `${propStr("properties", "portName")} AS port_name`,
      `${numMetric("metrics", "passenger_count")} AS passenger_count`,
      `${numMetric("metrics", "crew_count")} AS crew_count`,
    ],
    extraDimensions: [
      dim("port_locode", "string", "UN/LOCODE of the port (e.g. ISREY)."),
      dim("port_name", "string", "Port name (e.g. Reykjavík, Akureyri)."),
      dim("passenger_count", "number", "Scheduled passenger capacity on board."),
      dim("crew_count", "number", "Scheduled crew count on board."),
    ],
    extraMeasures: [
      measure("total_passengers", "sum", "Sum of scheduled cruise passengers.", "passenger_count"),
      measure("total_crew", "sum", "Sum of scheduled cruise crew.", "crew_count"),
    ],
  }),
  eventCube({
    name: "sports_events",
    title: "Sports Events",
    description: "Sports fixtures, matches, and tournaments with league, teams, and scores.",
    partition: "_open_",
    collectionGids: "d90f159a-3c4b-531e-b6f6-b566f2a20a12",
    refreshEvery: "1 hour",
    extraSelect: [
      "dimensions['league'] AS league",
      "dimensions['season'] AS season",
      "dimensions['round'] AS round",
      "dimensions['home_team'] AS home_team",
      "dimensions['away_team'] AS away_team",
      `${propStr("properties", "homeScore")} AS home_score`,
      `${propStr("properties", "awayScore")} AS away_score`,
    ],
    extraDimensions: [
      dim("league", "string", "Competition or league name."),
      dim("season", "string", "Competition season."),
      dim("round", "string", "Matchday or round."),
      dim("home_team", "string", "Home team name."),
      dim("away_team", "string", "Away team name."),
      dim("home_score", "string", "Reported home score when completed."),
      dim("away_score", "string", "Reported away score when completed."),
    ],
  }),
  eventCube({
    name: "cultural_events",
    title: "Cultural Events",
    description: "Public concerts, theatre performances, and festivals across Iceland (combined Tix and Gjugg feeds).",
    partition: "_open_",
    collectionGids: [
      "3f884bf7-284e-56ec-9041-ef39991e211a",
      "a4367c3a-7db8-54e5-bfba-f870079d0ee6",
    ],
    refreshEvery: "1 hour",
    extraSelect: [
      "if(collection_gid = toUUID('3f884bf7-284e-56ec-9041-ef39991e211a'), 'tix', 'gjugg') AS source",
      "dimensions['organisation'] AS organisation",
      "dimensions['hall'] AS hall",
      "dimensions['sale_status'] AS sale_status",
      `${numMetric("metrics", "price_min")} AS price_min`,
      `${numMetric("metrics", "price_max")} AS price_max`,
      `${numMetric("metrics", "duration")} AS duration`,
    ],
    extraDimensions: [
      dim("source", "string", "Source feed: 'tix' or 'gjugg'."),
      dim("organisation", "string", "Hosting organisation or promoter."),
      dim("hall", "string", "Specific hall or stage within the venue."),
      dim("sale_status", "string", "Ticket availability/sale status."),
      dim("price_min", "number", "Minimum ticket price in ISK (NULL when free/unspecified)."),
      dim("price_max", "number", "Maximum ticket price in ISK."),
      dim("duration", "number", "Performance duration in minutes."),
    ],
  }),
  eventCube({
    name: "tv_schedule",
    title: "TV Schedule",
    description: "Public television broadcast schedule with channel, program kind, episode, and duration.",
    partition: "_open_",
    collectionGids: "3916fd4f-b5d8-5936-9bf4-e432518048db",
    refreshEvery: "1 hour",
    extraSelect: [
      "dimensions['channel_id'] AS channel_id",
      "dimensions['channel_name'] AS channel_name",
      "dimensions['channel_group'] AS channel_group",
      "dimensions['program_kind'] AS program_kind",
      "dimensions['episode'] AS episode",
      "dimensions['language'] AS language",
      "dimensions['release_year'] AS release_year",
      `${numMetric("metrics", "duration")} AS duration`,
    ],
    extraDimensions: [
      dim("channel_id", "string", "Television channel identifier."),
      dim("channel_name", "string", "Television channel name."),
      dim("channel_group", "string", "Broadcaster channel group."),
      dim("program_kind", "string", "Program type (e.g. movie, series, sports, news)."),
      dim("episode", "string", "Episode identifier or number."),
      dim("language", "string", "Broadcast language code."),
      dim("release_year", "string", "Program production/release year."),
      dim("duration", "number", "Broadcast duration in minutes."),
    ],
  }),
];

// =========================================================================
// 5. Trading Economics Licensed Cubes — Enterprise (`premium: true`) ONLY
// =========================================================================
const PREMIUM_CUBES = [
  eventCube({
    name: "economic_calendar",
    title: "Economic Calendar (Enterprise)",
    description:
      "Macroeconomic release calendar with importance and actual/previous/forecast/consensus readings (Trading Economics, Enterprise licence required).",
    partition: "_open_",
    collectionGids: "0e4b1499-673f-5e9c-9f27-2f90f7de5de0",
    refreshEvery: "1 hour",
    extraSelect: [
      "dimensions['country'] AS country",
      "dimensions['category'] AS category",
      "dimensions['source'] AS source",
      `${numMetric("metrics", "importance")} AS importance`,
      `${propStr("properties", "actual")} AS actual`,
      `${propStr("properties", "previous")} AS previous`,
      `${propStr("properties", "forecast")} AS forecast`,
      `${propStr("properties", "consensus")} AS consensus`,
    ],
    extraDimensions: [
      dim("country", "string", "Country name."),
      dim("category", "string", "Macroeconomic release category (e.g. Inflation, GDP, Interest Rate)."),
      dim("source", "string", "Statistical agency or central bank source."),
      dim("importance", "number", "Market importance score (1 = low, 2 = medium, 3 = high)."),
      dim("actual", "string", "Published actual value."),
      dim("previous", "string", "Prior period reading."),
      dim("forecast", "string", "Trading Economics forecast."),
      dim("consensus", "string", "Market consensus estimate."),
    ],
  }),
  {
    name: "fx_rates",
    title: "Currency Exchange Rates (Enterprise)",
    description:
      "Daily OHLC currency exchange rates (Trading Economics, Enterprise licence required).",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(toString(dp.series_gid), ':', toString(dp.timestamp)) AS row_id,
        dp.timestamp AS timestamp,
        toString(toDate(dp.timestamp)) AS day,
        ts.subject_entity_label AS pair,
        ts.label AS series_label,
        toString(dp.entity_gid_url) AS entity_url,
        ${numMetric("dp.metrics", "open")} AS open_price,
        ${numMetric("dp.metrics", "high")} AS high_price,
        ${numMetric("dp.metrics", "low")} AS low_price,
        ${numMetric("dp.metrics", "close")} AS close_price
      FROM (
        SELECT series_gid, entity_gid_url, timestamp, metrics
        FROM cst.data_points
        WHERE partition = '_open_'
          AND access_type = 'Public'
          AND series_gid IN (
            SELECT gid FROM cst.timeseries FINAL
            WHERE data_service_gid = toUUID('${DATA_SERVICE.fx}')
          )
        ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
        LIMIT 1 BY series_gid, timestamp
      ) AS dp
      INNER JOIN (
        SELECT gid, subject_entity_label, label
        FROM cst.timeseries FINAL
        WHERE data_service_gid = toUUID('${DATA_SERVICE.fx}')
      ) AS ts ON ts.gid = dp.series_gid
    `.trim(),
    joins: [DAY_JOIN_IS],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Trading day timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("pair", "string", "Currency pair symbol (e.g. EURISK, USDISK, GBPISK)."),
      dim("series_label", "string", "Full series label."),
      dim("entity_url", "string", "Canonical entity URL."),
      dim("open_price", "number", "Opening exchange rate."),
      dim("high_price", "number", "Intraday high exchange rate."),
      dim("low_price", "number", "Intraday low exchange rate."),
      dim("close_price", "number", "Closing exchange rate."),
    ],
    measures: [
      measure("count", "count", "Number of daily FX rows."),
      measure("avg_close", "avg", "Average closing exchange rate.", "close_price"),
    ],
  },
  {
    name: "economic_indicators",
    title: "Economic Indicators (Enterprise)",
    description:
      "Macroeconomic indicator time series by country, category, and resolution (Trading Economics, Enterprise licence required).",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(toString(dp.series_gid), ':', toString(dp.timestamp)) AS row_id,
        dp.timestamp AS timestamp,
        ts.subject_entity_label AS country,
        ts.label AS indicator_name,
        toString(ts.slug) AS indicator_slug,
        toString(ts.category) AS category,
        toString(ts.sub_category) AS sub_category,
        toString(ts.resolution) AS resolution,
        ${numMetric("dp.metrics", "value")} AS value
      FROM (
        SELECT series_gid, timestamp, metrics
        FROM cst.data_points
        WHERE partition = '_open_'
          AND access_type = 'Public'
          AND series_gid IN (
            SELECT gid FROM cst.timeseries FINAL
            WHERE data_service_gid = toUUID('${DATA_SERVICE.indicators}')
          )
        ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
        LIMIT 1 BY series_gid, timestamp
      ) AS dp
      INNER JOIN (
        SELECT gid, subject_entity_label, label, slug, category, sub_category, resolution
        FROM cst.timeseries FINAL
        WHERE data_service_gid = toUUID('${DATA_SERVICE.indicators}')
      ) AS ts ON ts.gid = dp.series_gid
    `.trim(),
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Observation period timestamp (UTC)."),
      dim("country", "string", "Country name (e.g. Iceland, United States)."),
      dim("indicator_name", "string", "Human-readable indicator name."),
      dim("indicator_slug", "string", "Stable indicator slug."),
      dim("category", "string", "Top-level indicator domain (e.g. Economy, Energy, Health)."),
      dim("sub_category", "string", "Indicator sub-category (e.g. GDP, Prices, Labour, Trade)."),
      dim("resolution", "string", "Reporting cadence (ISO-8601 duration: P1M, P1Q, P1Y, P1D)."),
      dim("value", "number", "Reported macroeconomic indicator value."),
    ],
    measures: [
      measure("count", "count", "Number of indicator observations."),
      measure("avg_value", "avg", "Average indicator value.", "value"),
    ],
  },
  {
    name: "market_prices",
    title: "Market Prices (Enterprise)",
    description:
      "Daily OHLC prices for indices, bonds, commodities, crypto, and equities with asset_class filter (Trading Economics, Enterprise licence required).",
    refresh_key: { every: "1 hour" },
    sql: `
      SELECT
        concat(toString(dp.series_gid), ':', toString(dp.timestamp)) AS row_id,
        dp.timestamp AS timestamp,
        toString(toDate(dp.timestamp)) AS day,
        multiIf(
          ts.data_service_gid = toUUID('${DATA_SERVICE.indices}'), 'indices',
          ts.data_service_gid = toUUID('${DATA_SERVICE.bonds}'), 'bonds',
          ts.data_service_gid = toUUID('${DATA_SERVICE.commodities}'), 'commodities',
          ts.data_service_gid = toUUID('${DATA_SERVICE.crypto}'), 'crypto',
          ts.data_service_gid = toUUID('${DATA_SERVICE.equities}'), 'equities',
          'other'
        ) AS asset_class,
        ts.subject_entity_label AS instrument,
        ts.label AS series_label,
        toString(dp.entity_gid_url) AS entity_url,
        ${numMetric("dp.metrics", "open")} AS open_price,
        ${numMetric("dp.metrics", "high")} AS high_price,
        ${numMetric("dp.metrics", "low")} AS low_price,
        ${numMetric("dp.metrics", "close")} AS close_price
      FROM (
        SELECT series_gid, entity_gid_url, timestamp, metrics
        FROM cst.data_points
        WHERE partition = '_open_'
          AND access_type = 'Public'
          AND series_gid IN (
            SELECT gid FROM cst.timeseries FINAL
            WHERE data_service_gid IN (
              toUUID('${DATA_SERVICE.indices}'),
              toUUID('${DATA_SERVICE.bonds}'),
              toUUID('${DATA_SERVICE.commodities}'),
              toUUID('${DATA_SERVICE.crypto}'),
              toUUID('${DATA_SERVICE.equities}')
            )
          )
        ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
        LIMIT 1 BY series_gid, timestamp
      ) AS dp
      INNER JOIN (
        SELECT gid, data_service_gid, subject_entity_label, label
        FROM cst.timeseries FINAL
        WHERE data_service_gid IN (
          toUUID('${DATA_SERVICE.indices}'),
          toUUID('${DATA_SERVICE.bonds}'),
          toUUID('${DATA_SERVICE.commodities}'),
          toUUID('${DATA_SERVICE.crypto}'),
          toUUID('${DATA_SERVICE.equities}')
        )
      ) AS ts ON ts.gid = dp.series_gid
    `.trim(),
    joins: [DAY_JOIN_IS],
    dimensions: [
      dim("row_id", "string", "Internal row identifier.", { primary_key: true }),
      dim("timestamp", "time", "Trading day timestamp (UTC)."),
      dim("day", "string", "Calendar date (YYYY-MM-DD, UTC) for joins."),
      dim("asset_class", "string", "Asset class: 'indices', 'bonds', 'commodities', 'crypto', or 'equities'."),
      dim("instrument", "string", "Instrument ticker or name."),
      dim("series_label", "string", "Full instrument series label."),
      dim("entity_url", "string", "Canonical entity URL."),
      dim("open_price", "number", "Opening market price."),
      dim("high_price", "number", "Intraday high price."),
      dim("low_price", "number", "Intraday low price."),
      dim("close_price", "number", "Closing market price."),
    ],
    measures: [
      measure("count", "count", "Number of daily market price rows."),
      measure("avg_close", "avg", "Average closing price.", "close_price"),
    ],
  },
];

export const AUDVITAD_CORE_CUBE_NAMES = CORE_CUBES.map((c) => c.name);
export const AUDVITAD_PREMIUM_CUBE_NAMES = PREMIUM_CUBES.map((c) => c.name);

const renderFiles = (cubes) =>
  cubes.map((cube) => ({
    fileName: `audvitad/${cube.name}.yml`,
    readOnly: true,
    content: YAML.stringify({ cubes: [cube] }),
  }));

const PRO_FILES = Object.freeze(renderFiles(CORE_CUBES));
const ENTERPRISE_FILES = Object.freeze(renderFiles([...CORE_CUBES, ...PREMIUM_CUBES]));

const PRO_SCHEMA_VERSION = createMd5Hex(
  PRO_FILES.map((f) => [f.fileName, createMd5Hex(f.content)]),
);
const ENTERPRISE_SCHEMA_VERSION = createMd5Hex(
  ENTERPRISE_FILES.map((f) => [f.fileName, createMd5Hex(f.content)]),
);

export function getAudvitadSchemaFiles({ premium = false } = {}) {
  return (premium ? ENTERPRISE_FILES : PRO_FILES).map((f) => ({ ...f }));
}

export function getAudvitadSchemaVersion({ premium = false } = {}) {
  return premium ? ENTERPRISE_SCHEMA_VERSION : PRO_SCHEMA_VERSION;
}

export function getAudvitadCubeDefinitions({ premium = false } = {}) {
  return premium ? [...CORE_CUBES, ...PREMIUM_CUBES] : [...CORE_CUBES];
}
