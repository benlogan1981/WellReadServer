var pg = require('pg');

var books = require('./books.js');

exports.summaryCount = function () {
    console.log('summary counting!');
    var client = new pg.Client(conString);
    client.connect(function(err) {
      if(err) {
        return console.error('could not connect to postgres', err);
      }
      client.query('SELECT isbn, count(id) FROM public."SummaryText" group by isbn', function(err, result) {
        if(err) {
          return console.error('error running query', err);
        }
        var summaryCountJSON = [];
        for (var i = 0; i < result.rowCount; i++) {
          var scJSON = {
            "isbn":result.rows[i].isbn,
            "count":result.rows[i].count
          }
          summaryCountJSON.push(scJSON);
        }
        exports.summaryCountJSON = summaryCountJSON;
        client.end();
      });
    });
}

exports.summaryToDB = function (oAuthID, ISBN, text, response) {
    console.log('summaryToDB ISBN : ' + ISBN + ' text : ' + text);
    var client = new pg.Client(conString);
    client.connect(function(err) {
      if(err) {
        return console.error('could not connect to postgres', err);
      }
      console.log('summaryToDB about to execute db insert');
      client.query('INSERT INTO public."SummaryText" (oAuthID, isbn, text, datetime) VALUES (($1),($2),($3),now())', [oAuthID, ISBN, text], function(err, result) {
        if(err) {
          return console.error('error running query', err);
        }
        response.end('post acknowledged');
        client.end();
      });
    });
}

exports.voteSummaryToDB = function (oAuthID, summaryID, vote, response) {
    var client = new pg.Client(conString);
    client.connect(function(err) {
      if(err) {
        return console.error('could not connect to postgres', err);
      }
      console.log('voteSummaryToDB about to execute db insert');
      client.query('INSERT INTO public."SummaryVotes" (summaryID, vote, oAuthID, datetime) VALUES (($1),($2),($3),now())', [summaryID, vote, oAuthID], function(err, result) {
        if(err) {
          response.end('post error!');
          return console.error('error running query', err);
        }

        response.end('post acknowledged');

        client.end();
      });
    });
}

// rather than pass something in and forget about it,
// pass a callback!
// FIXME works well, just needs to be rolled out elsewhere...
exports.voteSummaryFromDB = function (oAuthID, response) {
    var client = new pg.Client(conString);
    client.connect(function(err) {
      if(err) {
        return console.error('could not connect to postgres', err);
      }
      console.log('voteSummaryFromDB about to execute db select');

      client.query('SELECT summaryid, SUM(vote) as votes from public."SummaryVotes" where oauthid = ($1) group by summaryid', [oAuthID], function(err, result) {
        if(err) {
          return console.error('error running query', err);
        }

        var votesJSON = [];
        for (var i = 0; i < result.rowCount; i++) {
          var voteJSON = {
            "id":result.rows[i].summaryid,
            "count":result.rows[i].votes
          }
          votesJSON.push(voteJSON);
        }

        client.end();
        response(JSON.stringify(votesJSON));
      });
    });
}

// FIXME blocking call issue, just passing the response in for now to get it working!
exports.summaryFromDB = function (ISBN, response, bookJSON) {
    var client = new pg.Client(conString);
    client.connect(function(err) {
        if(err) {
            return console.error('could not connect to postgres', err);
        }
        //client.query('SELECT id, text from public."SummaryText" where ISBN = ($1)', [ISBN], function(err, result) {
        //select id, text, SUM(v.vote) as votes from public."SummaryText" t, public."SummaryVotes" v where t.id=v.summaryid AND ISBN='1742200524' group by id;
        client.query('SELECT t.id, t.text, COALESCE(SUM(v.vote),0) as votes, u.name, t.datetime from public."SummaryText" t JOIN public."Users" u ON t.oauthid=u.oauthid LEFT OUTER JOIN public."SummaryVotes" v ON t.id=v.summaryid where ISBN = ($1) group by t.id, u.name order by votes DESC, id', [ISBN], function(err, result) {
        if(err) {
            return console.error('error running query', err);
        }
        //var summaryText = result.rows[0].text;
        var summary = [];

        // FIXME http://stackoverflow.com/questions/9205496/how-to-make-connection-to-postgres-via-node-js
        // shows a neat way of streaming back rows one at a time
        for (var i = 0; i < result.rowCount; i++) {
            var summaryJSON = {
                "id":result.rows[i].id,
                "datetime":result.rows[i].datetime,
                "text":result.rows[i].text,
                "name":result.rows[i].name,
                "votes":result.rows[i].votes
            }
            summary.push(summaryJSON);
        }

        //bookJSON.summary = summaryJSON;
        if(summary.length > 0) {
            bookJSON.summaryList = summary;
        }

        response.end(JSON.stringify(bookJSON));

        client.end();
        });
    });
}

// default cache life is 10 minutes, I think!
const NodeCache = require( "node-cache" );
const myCache = new NodeCache({ checkperiod: 3600 }); // cache for an hour, this is infrequently changing unimportant stuff

exports.topSummaries = function (number, response) {
    var cacheValue = myCache.get("topSummaries");
    if(cacheValue != undefined) {
      response.end(JSON.stringify(cacheValue));
    } else {
        var client = new pg.Client(conString);
        client.connect(function(err) {
          if(err) {
              return console.error('could not connect to postgres', err);
          }
          client.query('SELECT isbn, COUNT(text) as summary_count from public."SummaryText" group by isbn order by summary_count DESC limit ($1)', [number], function(err, result) {
          if(err) {
              return console.error('error running query', err);
          }
          var summary = [];
          var asinList = [];

          var resultCount = result.rowCount;
          if(resultCount > 0) {
            var counter = 0;
            // need recursion here rather than iteration, to connect the response to the final callback?
            repeater(counter);
            function repeater(i) {
                var asin = result.rows[i].isbn;
                asinList.push(asin);
                counter++;
                if(counter < resultCount) {
                  repeater(counter);
                }
            }
            var asinCommaList = '';
            for(var asin in asinList) {
                asinCommaList += asinList[asin] + ',';
            }
            asinCommaList = asinCommaList.substring(0, asinCommaList.length - 1);

            books.amazonBookLookupOnly(asinCommaList, function(amazonResult) {
              if(!amazonResult) {
                response.status(404).send({ error: "Problem retrieving data from Amazon!" });
              } else {
                for(var i1 = 0; i1 < amazonResult.length; i1++) {
                  var summaryJSON = {
                    "asin":amazonResult[i1].book.asin,
                    "title":amazonResult[i1].book.title,
                    "author":amazonResult[i1].book.author,
                    "summary_count":result.rows[i1].summary_count // does this really matter, as long as the order is correct? include it anyway, but not sure we can trust the array lookup here, implies ordering...
                  }
                  console.log('Adding to Top Summaries. Book : ' + summaryJSON.title);
                  summary.push(summaryJSON);
                }
                myCache.set("topSummaries", summary);
                response.end(JSON.stringify(summary));
              }
            });
          } else {
              response.end();
          }
          client.end();
          });
        });
    }
}

exports.mostRecent = function (number, response) {
    var cacheValue = myCache.get("mostRecent");
    if(cacheValue != undefined) {
      response.end(JSON.stringify(cacheValue));
    } else {
      var client = new pg.Client(conString);
      client.connect(function(err) {
          if(err) {
              return console.error('could not connect to postgres', err);
          }
          client.query('SELECT * from (SELECT DISTINCT ON (isbn) isbn, text, datetime from public."SummaryText" order by isbn, datetime DESC) s order by datetime DESC limit ($1)', [number], function(err, result) {
          if(err) {
              return console.error('error running query', err);
          }
          var summary = [];
          var asinList = [];

          var resultCount = result.rowCount;
          if(resultCount > 0) {
            var counter = 0;
            // need recursion here rather than iteration, to connect the response to the final callback?
            repeater(counter);
            function repeater(i) {
                var asin = result.rows[i].isbn;
                asinList.push(asin);
                counter++;
                if(counter < resultCount) {
                  repeater(counter);
                }
            }
            var asinCommaList = '';
            for(var asin in asinList) {
                asinCommaList += asinList[asin] + ',';
            }
            asinCommaList = asinCommaList.substring(0, asinCommaList.length - 1);

            books.amazonBookLookupOnly(asinCommaList, function(amazonResult) {
              if(!amazonResult) {
                response.status(404).send({ error: "Problem retrieving data from Amazon!" });
              } else {
                for(var i1 = 0; i1 < amazonResult.length; i1++) {
                  var summaryJSON = {
                    "asin":amazonResult[i1].book.asin,
                    "title":amazonResult[i1].book.title,
                    "author":amazonResult[i1].book.author,
                    "datetime":result.rows[i1].datetime
                  }
                  console.log('Adding to Most Recent. Book : ' + summaryJSON.title);
                  summary.push(summaryJSON);
                }
                myCache.set("mostRecent", summary);
                response.end(JSON.stringify(summary));
              }
            });
          } else {
              response.end();
          }
          client.end();
          });
        });
    }
}
