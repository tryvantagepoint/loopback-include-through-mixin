'use strict';

const _ = require('lodash');

module.exports = function(Model, options) {
  var modelHasManyThroughRelations, modelRelations;

  Model.on('attached', function() {
    modelRelations = Model.settings.relations || Model.relations;

    if (modelRelations) {
      modelHasManyThroughRelations = [];
      Object.keys(modelRelations).forEach(function(targetModel) {
        var type =
          (modelRelations[targetModel].modelThrough || modelRelations[targetModel].through) ?
            'hasManyThrough' : modelRelations[targetModel].type;

        if (type === 'hasManyThrough') {
          Model.afterRemote('prototype.__get__' + targetModel, controller);
          Model.afterRemote('prototype.__create__' + targetModel, controller);
          modelHasManyThroughRelations.push(targetModel);
        }
      });

      if (modelHasManyThroughRelations.length) {
        Model.afterRemote('findById', controller);
      }
    }
  });

  function controller(ctx, unused, next) {
    if (ctx.methodString.indexOf('prototype.__get__') !== -1) {
      // the original version
      var relationName = ctx.methodString.match(/__([a-zA-Z]+)$/)[1];
      var partialResult = JSON.parse(JSON.stringify(ctx.result));
      injectIncludes(ctx, partialResult, relationName).then(function(partialResult) {
        ctx.result = partialResult;
        next();
      });
    } else {
      // extension
      var newResult = JSON.parse(JSON.stringify(ctx.result));

      var filter = ctx.req && ctx.req.query && ctx.req.query.filter;
      if (filter) {
        if (typeof filter === 'string') {
          filter = JSON.parse(filter);
        }
        var include = filter.include; // string, [string], object

        // only support one level of includes
        var relationNames = [];
        if (_.isString(include)) {
          relationNames.push(include);
        } else if (_.isArray(include)) {
          for (let elm of include) {
            if (typeof elm === 'string') {
              relationNames.push(elm);
            } else if (typeof elm === 'object') {
              for (let prop in elm) {
                relationNames.push(prop);
              }
            }
          }
        } else if (_.isObject(include)) {
          for (let prop in include) {
            relationNames.push(prop);
          }
        }
        relationNames = _.uniq(relationNames);

        let promises = [];
        for (let relationName of relationNames) {
          if (modelHasManyThroughRelations.includes(relationName)) {
            let partialResult = newResult[relationName];
            let promise = injectIncludes(ctx, partialResult, relationName)
              .then(function(partialResult) {
                return new Promise(function(res, rej) {
                  newResult[relationName] = partialResult;
                  res();
                });
              });
            promises.push(promise);
          }
        }
        if (promises.length) {
          Promise.all(promises).then(function() {
            ctx.result = newResult;
            next();
          });
        } else {
          next();
        }
      } else {
        next();
      }
    }
  }

  function injectIncludes(ctx, partialResult, relationName) {
    return new Promise(function(res, rej) {
      var relationSetting, isRelationRegistered;
      if (options.relations) {
        relationSetting = _.find(options.relations, {name: relationName});
        if (relationSetting) {
          isRelationRegistered = true;
        } else if (options.relations.indexOf(relationName) !== -1) {
          isRelationRegistered = true;
          relationSetting = {};
          relationSetting.name = relationName;
        } else {
          isRelationRegistered = false;
        }
      }
      if (!isRelationRegistered  && !(ctx.args.filter && ctx.args.filter.includeThrough)) {
        return res(partialResult);
      }

      var relationKey = Model.relations[relationSetting.name].keyTo;
      var throughKey = Model.relations[relationSetting.name].keyThrough;
      var relationModel = Model.relations[relationSetting.name].modelTo;
      var throughModel = Model.relations[relationSetting.name].modelThrough;

      if (!relationModel) {
        return res(partialResult);
      }
      var idName = relationModel.definition.idName() || 'id';

      var query = {where: {}};
      if (ctx.instance) {
        query.where[relationKey] = ctx.instance.id;
      } else {
        query.where[relationKey] = ctx.args.id;
      }

      if (Array.isArray(partialResult)) {
        query.where[throughKey] = {inq: partialResult.map(function(item) { return item[idName]; })};
      } else {
        query.where[throughKey] = {inq: [partialResult[idName]]};
      }

      if (
        ctx.args.filter &&
        ctx.args.filter.includeThrough &&
        ctx.args.filter.includeThrough.fields
      ) {
        query.fields = [throughKey, ctx.args.filter.includeThrough.fields];
      } else if (options.fields && options.fields[relationSetting.name]) {
        query.fields = [throughKey, options.fields[relationSetting.name]];
      }

      throughModel.find(query, function(err, results) {
        if (err) return res(partialResult);
        else {
          var throughPropertyName = relationSetting.asProperty || throughModel.definition.name;
          var resultsHash = {};
          results.forEach(function(result) {
            resultsHash[result[throughKey].toString()] = result;
          });

          if (Array.isArray(partialResult)) {
            for (var i = 0; i < partialResult.length; i++) {
              if (resultsHash[partialResult[i][idName].toString()]) {
                partialResult[i][throughPropertyName] =
                  resultsHash[partialResult[i][idName].toString()];
              }
            }
          } else {
            partialResult[throughPropertyName] =
              resultsHash[partialResult[idName].toString()];
          }
          return res(partialResult);
        }
      });
    });
  };
};
