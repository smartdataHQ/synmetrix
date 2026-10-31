// Vendored from @cubejs-backend/schema-compiler 1.6.76 (Apache-2.0, LICENSE):
// Cube removed the Elasticsearch dialect in 1.7.0. Changes: imports from the
// installed schema-compiler; always the JS planner (constructor).
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElasticSearchQuery = void 0;
/* eslint-disable max-classes-per-file */
const ramda_1 = __importDefault(require("ramda"));
const shared_1 = require("@cubejs-backend/shared");
const BaseQuery_1 = require("@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery");
const BaseFilter_1 = require("@cubejs-backend/schema-compiler/dist/src/adapter/BaseFilter");
const GRANULARITY_TO_INTERVAL = {
    day: date => `DATE_TRUNC('day', ${date}::datetime)`,
    week: date => `DATE_TRUNC('week', ${date}::datetime)`,
    hour: date => `DATE_TRUNC('hour', ${date}::datetime)`,
    minute: date => `DATE_TRUNC('minute', ${date}::datetime)`,
    second: date => `DATE_TRUNC('second', ${date}::datetime)`,
    month: date => `DATE_TRUNC('month', ${date}::datetime)`,
    quarter: date => `DATE_TRUNC('quarter', ${date}::datetime)`,
    year: date => `DATE_TRUNC('year', ${date}::datetime)`
};
class ElasticSearchQueryFilter extends BaseFilter_1.BaseFilter {
    likeIgnoreCase(column, not, param, type) {
        if (type === 'starts') {
            return `${not ? ' NOT' : ''} WHERE ${column} LIKE ${this.allocateParam(param)}%`;
        }
        else if (type === 'ends') {
            return `${not ? ' NOT' : ''} WHERE ${column} LIKE %${this.allocateParam(param)}`;
        }
        else {
            return `${not ? ' NOT' : ''} MATCH(${column}, ${this.allocateParam(param)}, 'fuzziness=AUTO:1,5')`;
        }
    }
}
class ElasticSearchQuery extends BaseQuery_1.BaseQuery {
    constructor(compilers, options) {
        // Elasticsearch SQL was only ever planned by Cube's JS planner; the
        // Tesseract planner has no Elasticsearch templates.
        super(compilers, { ...options, useNativeSqlPlanner: false });
    }
    newFilter(filter) {
        return new ElasticSearchQueryFilter(this, filter);
    }
    convertTz(field) {
        return `${field}`; // TODO
    }
    timeStampCast(value) {
        return `${value}`;
    }
    dateTimeCast(value) {
        return `${value}`; // TODO
    }
    subtractInterval(date, interval) {
        // TODO: Test this, note sure how value gets populated here
        return `${date} - INTERVAL ${interval}`;
    }
    addInterval(date, interval) {
        // TODO: Test this, note sure how value gets populated here
        return `${date} + INTERVAL ${interval}`;
    }
    timeGroupedColumn(granularity, dimension) {
        return GRANULARITY_TO_INTERVAL[granularity](dimension);
    }
    unixTimestampSql() {
        return 'TIMESTAMP_DIFF(\'seconds\', \'1970-01-01T00:00:00.000Z\'::datetime, CURRENT_TIMESTAMP())';
    }
    groupByClause() {
        if (this.ungrouped) {
            return '';
        }
        const dimensionsForSelect = this.dimensionsForSelect();
        const dimensionColumns = ramda_1.default.flatten(dimensionsForSelect.map(s => s.selectColumns() && s.dimensionSql())).filter(s => !!s);
        return dimensionColumns.length ? ` GROUP BY ${dimensionColumns.join(', ')}` : '';
    }
    orderHashToString(hash) {
        if (!hash || !hash.id) {
            return null;
        }
        const fieldAlias = this.getFieldAlias(hash.id);
        if (fieldAlias === null) {
            return null;
        }
        const direction = hash.desc ? 'DESC' : 'ASC';
        return `${fieldAlias} ${direction}`;
    }
    /**
     * This implementation is a bit different from the one in BaseQuery
     * as it uses dimensionSql() as ordering expression
     */
    getFieldAlias(id) {
        const equalIgnoreCase = (a, b) => (typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase());
        let field;
        const path = id.split('.');
        // Granularity is specified
        if (path.length === 3) {
            const memberName = path.slice(0, 2).join('.');
            const granularity = path[2];
            field = this.timeDimensions
                // Not all time dimensions are used in select list, some are just filters,
                // but they exist in this.timeDimensions, so need to filter them out
                .filter(d => d.selectColumns())
                .find(d => ((equalIgnoreCase(d.dimension, memberName) && (d.granularityObj?.granularity === granularity)) ||
                equalIgnoreCase(d.expressionName, memberName)));
            if (field) {
                return field.dimensionSql();
            }
            return null;
        }
        const dimensionsForSelect = this.dimensionsForSelect()
            // Not all time dimensions are used in select list, some are just filters,
            // but they exist in this.timeDimensions, so need to filter them out
            .filter(d => d.selectColumns());
        const found = (0, shared_1.findMinGranularityDimension)(id, dimensionsForSelect);
        if (found?.dimension) {
            return found.dimension.dimensionSql();
        }
        field = this.measures.find(d => equalIgnoreCase(d.measure, id) || equalIgnoreCase(d.expressionName, id));
        if (field) {
            return field.aliasName(); // TODO isn't supported
        }
        return null;
    }
    escapeColumnName(name) {
        return `${name}`;
    }
}
exports.ElasticSearchQuery = ElasticSearchQuery;
//# sourceMappingURL=ElasticSearchQuery.js.map