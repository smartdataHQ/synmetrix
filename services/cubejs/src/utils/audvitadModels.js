import YAML from "yaml";
import createMd5Hex from "./md5Hex.js";

// Curated, read-only ClickHouse Cube models for Auðvitað / QuickLookup SQL access
// (Fag = pro, Fyrirtæki = enterprise).
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

const eventCube = ({ name, title, description, partition, collectionGids }) => {
  const gids = Array.isArray(collectionGids) ? collectionGids : [collectionGids];
  const gidPredicate =
    gids.length === 1
      ? `collection_gid = toUUID('${gids[0]}')`
      : `collection_gid IN (${gids.map((g) => `toUUID('${g}')`).join(", ")})`;

  return {
    name,
    title,
    description,
    sql: `
      SELECT
        toString(gid) AS event_id,
        name,
        description,
        toString(type) AS event_type,
        toString(sub_type) AS sub_type,
        date_from,
        date_to,
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
        if(epicenter_known, epicenter.2, CAST(NULL AS Nullable(Float64))) AS lat,
        if(epicenter_known, epicenter.1, CAST(NULL AS Nullable(Float64))) AS lon,
        event_url,
        ticket_url,
        capacity
      FROM ql.calendar_events FINAL
      WHERE is_deleted = 0
        AND partition = '${partition}'
        AND access = 'Public'
        AND ${gidPredicate}
    `.trim(),
    dimensions: [
      { name: "event_id", sql: "event_id", type: "string", primary_key: true },
      { name: "name", sql: "name", type: "string" },
      { name: "description", sql: "description", type: "string" },
      { name: "event_type", sql: "event_type", type: "string" },
      { name: "sub_type", sql: "sub_type", type: "string" },
      { name: "date_from", sql: "date_from", type: "time" },
      { name: "date_to", sql: "date_to", type: "time" },
      { name: "all_day", sql: "all_day", type: "boolean" },
      { name: "timezone", sql: "timezone", type: "string" },
      { name: "status", sql: "status", type: "string" },
      { name: "is_cancelled", sql: "is_cancelled", type: "boolean" },
      { name: "country_code", sql: "country_code", type: "string" },
      { name: "region", sql: "region", type: "string" },
      { name: "locality", sql: "locality", type: "string" },
      { name: "postal_code", sql: "postal_code", type: "string" },
      { name: "venue", sql: "venue", type: "string" },
      { name: "address", sql: "address", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "event_url", sql: "event_url", type: "string" },
      { name: "ticket_url", sql: "ticket_url", type: "string" },
      { name: "capacity", sql: "capacity", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "total_capacity", sql: "capacity", type: "sum" },
    ],
  };
};

const trafficIntervalCube = ({ name, title, description, seriesGid }) => ({
  name,
  title,
  description,
  sql: `
    SELECT
      concat(
        toString(dp.entity_gid), ':',
        toString(dp.timestamp), ':',
        dp.dimensions['traffic_direction_id'], ':',
        dp.dimensions['traffic_size_class']
      ) AS row_id,
      dp.timestamp AS timestamp,
      dp.dimensions['traffic_station_id'] AS station_id,
      dp.dimensions['traffic_station_name'] AS station_name,
      coalesce(sp.region, '') AS region,
      coalesce(sp.municipality, '') AS municipality,
      coalesce(sp.road_name, '') AS road_name,
      coalesce(sp.road_number, '') AS road_number,
      dp.dimensions['traffic_direction_id'] AS direction_id,
      dp.dimensions['traffic_direction_role'] AS direction_role,
      dp.dimensions['traffic_direction_text'] AS direction_text,
      dp.dimensions['traffic_size_class'] AS size_class,
      dp.location_point.2 AS lat,
      dp.location_point.1 AS lon,
      dp.metrics['vehicle_count'] AS vehicle_count
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
      SELECT station_id, region, municipality, road_name, road_number
      FROM cst.traffic_station_places
      WHERE partition = '_open_'
    ) AS sp ON sp.station_id = dp.dimensions['traffic_station_id']
  `.trim(),
  dimensions: [
    { name: "row_id", sql: "row_id", type: "string", primary_key: true },
    { name: "timestamp", sql: "timestamp", type: "time" },
    { name: "station_id", sql: "station_id", type: "string" },
    { name: "station_name", sql: "station_name", type: "string" },
    { name: "region", sql: "region", type: "string" },
    { name: "municipality", sql: "municipality", type: "string" },
    { name: "road_name", sql: "road_name", type: "string" },
    { name: "road_number", sql: "road_number", type: "string" },
    { name: "direction_id", sql: "direction_id", type: "string" },
    { name: "direction_role", sql: "direction_role", type: "string" },
    { name: "direction_text", sql: "direction_text", type: "string" },
    { name: "size_class", sql: "size_class", type: "string" },
    { name: "lat", sql: "lat", type: "number" },
    { name: "lon", sql: "lon", type: "number" },
    { name: "vehicle_count", sql: "vehicle_count", type: "number" },
  ],
  measures: [
    { name: "count", type: "count" },
    { name: "total_vehicles", sql: "vehicle_count", type: "sum" },
    { name: "avg_vehicles", sql: "vehicle_count", type: "avg" },
  ],
});

const CORE_CUBES = [
  // 1. Traffic & Roads (Vegagerðin)
  {
    name: "traffic_daily",
    title: "Daily Road Traffic",
    description:
      "Daily Vegagerðin road traffic counts across Iceland, deduplicated to prefer published daily totals.",
    sql: `
      SELECT
        concat(
          toString(dp.entity_gid), ':',
          toString(dp.timestamp), ':',
          dp.dimensions['traffic_direction_id'], ':',
          dp.dimensions['traffic_size_class']
        ) AS row_id,
        dp.timestamp AS timestamp,
        dp.dimensions['traffic_station_id'] AS station_id,
        dp.dimensions['traffic_station_name'] AS station_name,
        coalesce(sp.region, '') AS region,
        coalesce(sp.municipality, '') AS municipality,
        coalesce(sp.road_name, '') AS road_name,
        coalesce(sp.road_number, '') AS road_number,
        dp.dimensions['traffic_direction_id'] AS direction_id,
        dp.dimensions['traffic_direction_role'] AS direction_role,
        dp.dimensions['traffic_direction_text'] AS direction_text,
        dp.dimensions['traffic_size_class'] AS size_class,
        dp.dimensions['traffic_counter_type'] AS counter_type,
        dp.dimensions['traffic_count_basis'] AS count_basis,
        dp.location_point.2 AS lat,
        dp.location_point.1 AS lon,
        dp.metrics['vehicle_count'] AS vehicle_count,
        dp.metrics['reported_intervals'] AS reported_intervals,
        dp.metrics['expected_intervals'] AS expected_intervals
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
        SELECT station_id, region, municipality, road_name, road_number
        FROM cst.traffic_station_places
        WHERE partition = '_open_'
      ) AS sp ON sp.station_id = dp.dimensions['traffic_station_id']
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "station_id", sql: "station_id", type: "string" },
      { name: "station_name", sql: "station_name", type: "string" },
      { name: "region", sql: "region", type: "string" },
      { name: "municipality", sql: "municipality", type: "string" },
      { name: "road_name", sql: "road_name", type: "string" },
      { name: "road_number", sql: "road_number", type: "string" },
      { name: "direction_id", sql: "direction_id", type: "string" },
      { name: "direction_role", sql: "direction_role", type: "string" },
      { name: "direction_text", sql: "direction_text", type: "string" },
      { name: "size_class", sql: "size_class", type: "string" },
      { name: "counter_type", sql: "counter_type", type: "string" },
      { name: "count_basis", sql: "count_basis", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "vehicle_count", sql: "vehicle_count", type: "number" },
      { name: "reported_intervals", sql: "reported_intervals", type: "number" },
      { name: "expected_intervals", sql: "expected_intervals", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "total_vehicles", sql: "vehicle_count", type: "sum" },
      { name: "avg_vehicles", sql: "vehicle_count", type: "avg" },
    ],
  },
  trafficIntervalCube({
    name: "traffic_15m",
    title: "15-Minute Road Traffic",
    description: "15-minute Vegagerðin road traffic counts.",
    seriesGid: "e635e0f5-7cb2-5112-9f68-b86840067a12",
  }),
  trafficIntervalCube({
    name: "traffic_10m",
    title: "10-Minute Road Traffic",
    description: "10-minute Vegagerðin road traffic counts.",
    seriesGid: "67f55250-4594-5d10-a7d5-8d48cfde9ca0",
  }),
  {
    name: "road_conditions",
    title: "Road Conditions",
    description: "Daily Icelandic road closure and mountain-road flags.",
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp)) AS row_id,
        timestamp,
        toString(entity_gid) AS entity_id,
        toString(entity_gid_url) AS entity_url,
        location_point.2 AS lat,
        location_point.1 AS lon,
        metrics['road_closed'] AS road_closed,
        metrics['road_mountain_only'] AS road_mountain_only
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('20f5fc66-b18d-51e1-ad16-f690c7bfdec3')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "entity_id", sql: "entity_id", type: "string" },
      { name: "entity_url", sql: "entity_url", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "road_closed", sql: "road_closed", type: "number" },
      { name: "road_mountain_only", sql: "road_mountain_only", type: "number" },
    ],
    measures: [{ name: "count", type: "count" }],
  },

  // 2. Fuel & Hospitality
  {
    name: "fuel_prices",
    title: "Fuel Prices",
    description: "Daily retail fuel prices by station, brand and fuel type in Iceland.",
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['fuel_type']
        ) AS row_id,
        timestamp,
        dimensions['company'] AS company,
        dimensions['company_name'] AS company_name,
        dimensions['station_name'] AS station_name,
        dimensions['fuel_type'] AS fuel_type,
        location_point.2 AS lat,
        location_point.1 AS lon,
        metrics['price'] AS price,
        metrics['discount_price'] AS discount_price
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('0d9da0da-4324-5898-bc12-dae8e30b07a3')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['fuel_type']
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "company", sql: "company", type: "string" },
      { name: "company_name", sql: "company_name", type: "string" },
      { name: "station_name", sql: "station_name", type: "string" },
      { name: "fuel_type", sql: "fuel_type", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "price", sql: "price", type: "number" },
      { name: "discount_price", sql: "discount_price", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "avg_price", sql: "price", type: "avg" },
      { name: "min_price", sql: "price", type: "min" },
      { name: "max_price", sql: "price", type: "max" },
      { name: "avg_discount_price", sql: "discount_price", type: "avg" },
    ],
  },
  {
    name: "hotel_statistics",
    title: "Hotel Statistics",
    description: "Monthly Icelandic hotel capacity and guest nights by region (Statistics Iceland).",
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp), ':', dimensions['region_name']) AS row_id,
        timestamp,
        dimensions['region_name'] AS region_name,
        metrics['hotels_count'] AS hotels_count,
        metrics['rooms_count'] AS rooms_count,
        metrics['beds_count'] AS beds_count,
        metrics['guest_nights_total'] AS guest_nights_total,
        metrics['guest_nights_domestic'] AS guest_nights_domestic,
        metrics['guest_nights_foreign'] AS guest_nights_foreign
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('ce8e9c9e-de84-5006-ae4b-1c6dc5185ac4')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['region_name']
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "region_name", sql: "region_name", type: "string" },
      { name: "hotels_count", sql: "hotels_count", type: "number" },
      { name: "rooms_count", sql: "rooms_count", type: "number" },
      { name: "beds_count", sql: "beds_count", type: "number" },
      { name: "guest_nights_total", sql: "guest_nights_total", type: "number" },
      { name: "guest_nights_domestic", sql: "guest_nights_domestic", type: "number" },
      { name: "guest_nights_foreign", sql: "guest_nights_foreign", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "total_guest_nights", sql: "guest_nights_total", type: "sum" },
      { name: "total_foreign_guest_nights", sql: "guest_nights_foreign", type: "sum" },
      { name: "total_domestic_guest_nights", sql: "guest_nights_domestic", type: "sum" },
    ],
  },

  // 3. Weather, Daylight & Context
  {
    name: "weather",
    title: "Weather Metrics",
    description: "Observed and forecast weather metrics by location and part of day.",
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
        dimensions['geohash'] AS geohash,
        dimensions['period'] AS day_part,
        dimensions['summarize'] AS summary_method,
        dimensions['timezone'] AS timezone,
        location_point.2 AS lat,
        location_point.1 AS lon,
        metrics['temperature'] AS temperature,
        metrics['feels_like'] AS feels_like,
        metrics['wind_speed'] AS wind_speed,
        metrics['wind_gust'] AS wind_gust,
        metrics['wind_direction'] AS wind_direction,
        metrics['precipitation_rain'] AS precipitation_rain,
        metrics['precipitation_snow'] AS precipitation_snow,
        metrics['cloud_cover'] AS cloud_cover,
        metrics['humidity'] AS humidity,
        metrics['pressure'] AS pressure,
        metrics['visibility'] AS visibility,
        metrics['dew_point'] AS dew_point
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
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "geohash", sql: "geohash", type: "string" },
      { name: "day_part", sql: "day_part", type: "string" },
      { name: "summary_method", sql: "summary_method", type: "string" },
      { name: "timezone", sql: "timezone", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "temperature", sql: "temperature", type: "number" },
      { name: "feels_like", sql: "feels_like", type: "number" },
      { name: "wind_speed", sql: "wind_speed", type: "number" },
      { name: "wind_gust", sql: "wind_gust", type: "number" },
      { name: "wind_direction", sql: "wind_direction", type: "number" },
      { name: "precipitation_rain", sql: "precipitation_rain", type: "number" },
      { name: "precipitation_snow", sql: "precipitation_snow", type: "number" },
      { name: "cloud_cover", sql: "cloud_cover", type: "number" },
      { name: "humidity", sql: "humidity", type: "number" },
      { name: "pressure", sql: "pressure", type: "number" },
      { name: "visibility", sql: "visibility", type: "number" },
      { name: "dew_point", sql: "dew_point", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "avg_temperature", sql: "temperature", type: "avg" },
      { name: "avg_wind_speed", sql: "wind_speed", type: "avg" },
      { name: "total_rain", sql: "precipitation_rain", type: "sum" },
      { name: "total_snow", sql: "precipitation_snow", type: "sum" },
    ],
  },
  {
    name: "weather_normals",
    title: "Weather Normals",
    description: "Multi-year historical weather averages and medians by location and calendar day.",
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
        dimensions['geohash'] AS geohash,
        dimensions['period'] AS day_part,
        dimensions['years'] AS baseline_years,
        dimensions['window_size'] AS window_size,
        location_point.2 AS lat,
        location_point.1 AS lon,
        metrics['temperature_avg'] AS temperature_avg,
        metrics['temperature_p50'] AS temperature_p50,
        metrics['wind_speed_avg'] AS wind_speed_avg,
        metrics['wind_speed_p50'] AS wind_speed_p50,
        metrics['precipitation_rain_avg'] AS precipitation_rain_avg,
        metrics['precipitation_snow_avg'] AS precipitation_snow_avg,
        metrics['cloud_cover_avg'] AS cloud_cover_avg,
        metrics['humidity_avg'] AS humidity_avg,
        metrics['pressure_avg'] AS pressure_avg
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
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "geohash", sql: "geohash", type: "string" },
      { name: "day_part", sql: "day_part", type: "string" },
      { name: "baseline_years", sql: "baseline_years", type: "string" },
      { name: "window_size", sql: "window_size", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "temperature_avg", sql: "temperature_avg", type: "number" },
      { name: "temperature_p50", sql: "temperature_p50", type: "number" },
      { name: "wind_speed_avg", sql: "wind_speed_avg", type: "number" },
      { name: "wind_speed_p50", sql: "wind_speed_p50", type: "number" },
      { name: "precipitation_rain_avg", sql: "precipitation_rain_avg", type: "number" },
      { name: "precipitation_snow_avg", sql: "precipitation_snow_avg", type: "number" },
      { name: "cloud_cover_avg", sql: "cloud_cover_avg", type: "number" },
      { name: "humidity_avg", sql: "humidity_avg", type: "number" },
      { name: "pressure_avg", sql: "pressure_avg", type: "number" },
    ],
    measures: [{ name: "count", type: "count" }],
  },
  {
    name: "daylight",
    title: "Daylight and Celestial",
    description: "Daily sunrise, sunset, twilight, day length and moon phase by location.",
    sql: `
      SELECT
        concat(toString(entity_gid), ':', toString(timestamp), ':', dimensions['geohash']) AS row_id,
        timestamp,
        dimensions['geohash'] AS geohash,
        dimensions['timezone'] AS timezone,
        dimensions['sunrise'] AS sunrise,
        dimensions['sunset'] AS sunset,
        dimensions['solar_noon'] AS solar_noon,
        dimensions['civil_dawn'] AS civil_dawn,
        dimensions['civil_dusk'] AS civil_dusk,
        dimensions['moon_phase_name'] AS moon_phase_name,
        location_point.2 AS lat,
        location_point.1 AS lon,
        metrics['day_length_hours'] AS day_length_hours,
        metrics['moon_fraction'] AS moon_fraction,
        metrics['moon_phase_value'] AS moon_phase_value
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('de8bcfe7-d57c-5648-a867-99885763e786')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['geohash']
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "geohash", sql: "geohash", type: "string" },
      { name: "timezone", sql: "timezone", type: "string" },
      { name: "sunrise", sql: "sunrise", type: "string" },
      { name: "sunset", sql: "sunset", type: "string" },
      { name: "solar_noon", sql: "solar_noon", type: "string" },
      { name: "civil_dawn", sql: "civil_dawn", type: "string" },
      { name: "civil_dusk", sql: "civil_dusk", type: "string" },
      { name: "moon_phase_name", sql: "moon_phase_name", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "day_length_hours", sql: "day_length_hours", type: "number" },
      { name: "moon_fraction", sql: "moon_fraction", type: "number" },
      { name: "moon_phase_value", sql: "moon_phase_value", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "avg_day_length_hours", sql: "day_length_hours", type: "avg" },
    ],
  },
  {
    name: "day_archetypes",
    title: "Day Archetypes",
    description: "Calendar day classifications: workday, weekend, holiday, season and streak features.",
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['country_code'], ':',
          dimensions['geohash']
        ) AS row_id,
        timestamp,
        dimensions['country_code'] AS country_code,
        dimensions['geohash'] AS geohash,
        dimensions['day_name'] AS day_name,
        dimensions['month_name'] AS month_name,
        dimensions['season_name'] AS season_name,
        dimensions['archetype_marker'] AS archetype_marker,
        dimensions['is_workday'] = 'true' AS is_workday,
        dimensions['is_weekend'] = 'true' AS is_weekend,
        dimensions['is_holiday'] = 'true' AS is_holiday,
        dimensions['is_vacation_season'] = 'true' AS is_vacation_season,
        metrics['day_of_week'] AS day_of_week,
        metrics['week_of_year'] AS week_of_year,
        metrics['hours_of_daylight'] AS hours_of_daylight,
        metrics['workday_streak'] AS workday_streak,
        metrics['non_workday_streak'] AS non_workday_streak
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('ea04a69d-de7e-5f27-ae69-62323c6d79ed')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['country_code'], dimensions['geohash']
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "country_code", sql: "country_code", type: "string" },
      { name: "geohash", sql: "geohash", type: "string" },
      { name: "day_name", sql: "day_name", type: "string" },
      { name: "month_name", sql: "month_name", type: "string" },
      { name: "season_name", sql: "season_name", type: "string" },
      { name: "archetype_marker", sql: "archetype_marker", type: "string" },
      { name: "is_workday", sql: "is_workday", type: "boolean" },
      { name: "is_weekend", sql: "is_weekend", type: "boolean" },
      { name: "is_holiday", sql: "is_holiday", type: "boolean" },
      { name: "is_vacation_season", sql: "is_vacation_season", type: "boolean" },
      { name: "day_of_week", sql: "day_of_week", type: "number" },
      { name: "week_of_year", sql: "week_of_year", type: "number" },
      { name: "hours_of_daylight", sql: "hours_of_daylight", type: "number" },
      { name: "workday_streak", sql: "workday_streak", type: "number" },
      { name: "non_workday_streak", sql: "non_workday_streak", type: "number" },
    ],
    measures: [{ name: "count", type: "count" }],
  },
  {
    name: "activity_ratings",
    title: "Activity Ratings",
    description: "Daily suitability scores for outdoor activities based on weather and daylight.",
    sql: `
      SELECT
        concat(
          toString(entity_gid), ':',
          toString(timestamp), ':',
          dimensions['geohash'], ':',
          dimensions['activity']
        ) AS row_id,
        timestamp,
        dimensions['geohash'] AS geohash,
        dimensions['activity'] AS activity,
        dimensions['timezone'] AS timezone,
        location_point.2 AS lat,
        location_point.1 AS lon,
        metrics['rating'] AS rating,
        metrics['fit_score'] AS fit_score,
        metrics['daylight_score'] AS daylight_score,
        metrics['service_score'] AS service_score
      FROM cst.data_points
      WHERE partition = '_open_'
        AND access_type = 'Public'
        AND series_gid = toUUID('5c120b29-b563-567f-99fa-deb61a39e9f7')
      ORDER BY coalesce(as_of, created_at, timestamp) DESC, created_at DESC, signature DESC
      LIMIT 1 BY entity_gid, timestamp, dimensions['geohash'], dimensions['activity']
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "geohash", sql: "geohash", type: "string" },
      { name: "activity", sql: "activity", type: "string" },
      { name: "timezone", sql: "timezone", type: "string" },
      { name: "lat", sql: "lat", type: "number" },
      { name: "lon", sql: "lon", type: "number" },
      { name: "rating", sql: "rating", type: "number" },
      { name: "fit_score", sql: "fit_score", type: "number" },
      { name: "daylight_score", sql: "daylight_score", type: "number" },
      { name: "service_score", sql: "service_score", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "avg_rating", sql: "rating", type: "avg" },
    ],
  },

  // 4. Events & Calendars
  eventCube({
    name: "holidays",
    title: "Public Holidays",
    description: "Public holidays and observances in Iceland and worldwide.",
    partition: "_open_",
    collectionGids: "037fd8b2-2918-5e6e-8bee-13bfec7c8326",
  }),
  eventCube({
    name: "school_calendars",
    title: "School Calendars",
    description: "Icelandic school calendars: days off, reduced days, exams and term dates.",
    partition: "snjallgogn.is",
    collectionGids: "6fdcc15e-235b-5703-a212-452a0b1acba9",
  }),
  eventCube({
    name: "demand_drivers",
    title: "Icelandic Demand Drivers",
    description: "Icelandic market calendar: promotions, tournaments, festivals and commercial observances.",
    partition: "snjallgogn.is",
    collectionGids: "1fbab555-7a02-5982-8e14-a78aea274662",
  }),
  eventCube({
    name: "natural_hazards",
    title: "Natural Hazards",
    description: "Earthquakes, weather alerts and volcanic hazard events in Iceland.",
    partition: "_open_",
    collectionGids: "2dae4ade-d788-520d-a548-75769fe8fb7d",
  }),
  eventCube({
    name: "flights",
    title: "Flights (KEF)",
    description: "Keflavík International Airport (KEF) flight arrivals and departures.",
    partition: "_open_",
    collectionGids: "40c34e2e-4a93-5fd5-b8f1-3829b6b16def",
  }),
  eventCube({
    name: "cruise_ships",
    title: "Cruise Ships",
    description: "Scheduled cruise ship port calls across Icelandic ports.",
    partition: "_open_",
    collectionGids: "ecbd451a-3b31-5c01-964f-868cf28115f7",
  }),
  eventCube({
    name: "sports_events",
    title: "Sports Events",
    description: "Sports fixtures, matches and tournaments.",
    partition: "_open_",
    collectionGids: "d90f159a-3c4b-531e-b6f6-b566f2a20a12",
  }),
  eventCube({
    name: "cultural_events",
    title: "Cultural Events",
    description: "Public concerts, theatre performances and festivals across Iceland (Tix and Gjugg).",
    partition: "_open_",
    collectionGids: [
      "3f884bf7-284e-56ec-9041-ef39991e211a",
      "a4367c3a-7db8-54e5-bfba-f870079d0ee6",
    ],
  }),
  eventCube({
    name: "tv_schedule",
    title: "TV Schedule",
    description: "Public television broadcast schedule.",
    partition: "_open_",
    collectionGids: "3916fd4f-b5d8-5936-9bf4-e432518048db",
  }),
];

// Trading Economics licensed third-party cubes — Enterprise (`premium: true`) ONLY.
const PREMIUM_CUBES = [
  eventCube({
    name: "economic_calendar",
    title: "Economic Calendar (Enterprise)",
    description: "Macroeconomic release calendar (Trading Economics, Enterprise licence required).",
    partition: "_open_",
    collectionGids: "0e4b1499-673f-5e9c-9f27-2f90f7de5de0",
  }),
  {
    name: "fx_rates",
    title: "Currency Exchange Rates (Enterprise)",
    description: "Daily OHLC currency exchange rates (Trading Economics, Enterprise licence required).",
    sql: `
      SELECT
        concat(toString(dp.series_gid), ':', toString(dp.timestamp)) AS row_id,
        dp.timestamp AS timestamp,
        ts.subject_entity_label AS pair,
        ts.label AS series_label,
        toString(dp.entity_gid_url) AS entity_url,
        dp.metrics['open'] AS open_price,
        dp.metrics['high'] AS high_price,
        dp.metrics['low'] AS low_price,
        dp.metrics['close'] AS close_price
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
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "pair", sql: "pair", type: "string" },
      { name: "series_label", sql: "series_label", type: "string" },
      { name: "entity_url", sql: "entity_url", type: "string" },
      { name: "open_price", sql: "open_price", type: "number" },
      { name: "high_price", sql: "high_price", type: "number" },
      { name: "low_price", sql: "low_price", type: "number" },
      { name: "close_price", sql: "close_price", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "avg_close", sql: "close_price", type: "avg" },
    ],
  },
  {
    name: "economic_indicators",
    title: "Economic Indicators (Enterprise)",
    description: "Macroeconomic indicator time series (Trading Economics, Enterprise licence required).",
    sql: `
      SELECT
        concat(toString(dp.series_gid), ':', toString(dp.timestamp)) AS row_id,
        dp.timestamp AS timestamp,
        ts.subject_entity_label AS country,
        ts.label AS indicator_name,
        toString(ts.slug) AS indicator_slug,
        toString(ts.resolution) AS resolution,
        dp.metrics['value'] AS value
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
        SELECT gid, subject_entity_label, label, slug, resolution
        FROM cst.timeseries FINAL
        WHERE data_service_gid = toUUID('${DATA_SERVICE.indicators}')
      ) AS ts ON ts.gid = dp.series_gid
    `.trim(),
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "country", sql: "country", type: "string" },
      { name: "indicator_name", sql: "indicator_name", type: "string" },
      { name: "indicator_slug", sql: "indicator_slug", type: "string" },
      { name: "resolution", sql: "resolution", type: "string" },
      { name: "value", sql: "value", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "avg_value", sql: "value", type: "avg" },
    ],
  },
  {
    name: "market_prices",
    title: "Market Prices (Enterprise)",
    description:
      "Daily OHLC prices for indices, bonds, commodities, crypto and equities (Trading Economics, Enterprise licence required).",
    sql: `
      SELECT
        concat(toString(dp.series_gid), ':', toString(dp.timestamp)) AS row_id,
        dp.timestamp AS timestamp,
        ts.subject_entity_label AS instrument,
        ts.label AS series_label,
        toString(dp.entity_gid_url) AS entity_url,
        dp.metrics['open'] AS open_price,
        dp.metrics['high'] AS high_price,
        dp.metrics['low'] AS low_price,
        dp.metrics['close'] AS close_price
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
        SELECT gid, subject_entity_label, label
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
    dimensions: [
      { name: "row_id", sql: "row_id", type: "string", primary_key: true },
      { name: "timestamp", sql: "timestamp", type: "time" },
      { name: "instrument", sql: "instrument", type: "string" },
      { name: "series_label", sql: "series_label", type: "string" },
      { name: "entity_url", sql: "entity_url", type: "string" },
      { name: "open_price", sql: "open_price", type: "number" },
      { name: "high_price", sql: "high_price", type: "number" },
      { name: "low_price", sql: "low_price", type: "number" },
      { name: "close_price", sql: "close_price", type: "number" },
    ],
    measures: [
      { name: "count", type: "count" },
      { name: "avg_close", sql: "close_price", type: "avg" },
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
