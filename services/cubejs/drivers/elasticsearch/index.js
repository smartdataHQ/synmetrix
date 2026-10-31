// Elasticsearch datasources (removed from Cube in 1.7.0). Cube resolves a type
// it does not ship to the package `<type>-cubejs-driver`, and takes the SQL
// dialect from the driver's static dialectClass().
const ElasticSearchDriver = require('./ElasticSearchDriver');
const { ElasticSearchQuery } = require('./ElasticSearchQuery');

class SynmetrixElasticSearchDriver extends ElasticSearchDriver {
  static dialectClass() {
    return ElasticSearchQuery;
  }
}

module.exports = SynmetrixElasticSearchDriver;
module.exports.default = SynmetrixElasticSearchDriver;
