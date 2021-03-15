/**** Start of imports. If edited, may not auto-convert in the playground. ****/
var stepAridAndValleyThicket = ee.FeatureCollection("users/dugalh/extend_thicket_agc/step_arid_and_valley_thicket"),
    gefCalibPlots = ee.FeatureCollection("users/dugalh/extend_thicket_agc/gef_calib_plots"),
    gefSamplingPlots = ee.FeatureCollection("users/dugalh/extend_thicket_agc/gef_sampling_plots");
/***** End of imports. If edited, may not auto-convert in the playground. *****/
// Calibrate the GEF AGC model to Landsat / Sentinel imagery and evaluate accuracy 
var cloudMasking = require('users/dugalh/extend_thicket_agc:modules/cloud_masking.js');
var thicketBoundary = stepAridAndValleyThicket;  // STEP derived thicket boundaries
var gefAgcModel = {   // the univariate log(mean(R/pan)) WV3 2017 model
  m: ee.Number(-318.8304), 
  c: ee.Number(25.7259) 
}; 

// convert kg to tonnes
gefSamplingPlots = gefSamplingPlots.map(function (feature) {
  return feature.set({
    AgcHa: ee.Number(feature.get('AgcHa')).divide(1000)
  });
});

// var s2_toa_images = ee.ImageCollection('COPERNICUS/S2')
//                   .filterDate('2017-09-01', '2017-11-01')
//                   .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 5))
//                   .filterBounds(thicketBoundary)
//                   .map(cloudMasking.s2_simple_cloud_mask);

var l8SrImages = ee.ImageCollection('LANDSAT/LC08/C01/T1_SR')
  .filterDate('2017-09-01', '2017-12-30')
  .filterBounds(thicketBoundary)
  // .filterMetadata('GEOMETRIC_RMSE_MODEL', "less_than", 10)
  // .filterMetadata('SOLAR_ZENITH_ANGLE', "greater_than", 40)
  // .filterMetadata('SOLAR_AZIMUTH_ANGLE', "less_than", 50)
  .map(cloudMasking.landsat8SrCloudMask);

var images = l8SrImages;
print('Number of images: ', images.size());
var image = images.median();    // composite the image collection

// Find R/pan image feature
function findRn(image) {
  var rnImage = image.expression('(R / (R + G + B + RE))',
    {
      'R': image.select('B4'),
      'G': image.select('B3'),
      'B': image.select('B2'),
      'RE': image.select(ee.Algorithms.If(image.bandNames().contains('B8'), ['B8'], ['B5']))
    });
  return ee.Image(rnImage).rename('rN');
}
var rnImage = findRn(image);

// Split train and test data
var split = 0.5;
var calibPlots = gefCalibPlots.randomColumn('random', 0);
var trainCalibPlots = calibPlots.filter(ee.Filter.lt('random', split));
var testCalibPlots = calibPlots.filter(ee.Filter.gte('random', split));

// Calibrate the GEF AGC model to EE imagery and find EE AGC
function modelAgc(rnImage, trainPlots) {

  // find mean(R/pan) for each calibration plot
  var rnPlots = rnImage.reduceRegions({
    reducer: ee.Reducer.mean(),
    collection: trainPlots,
    scale: 1
  });

  // find log(mean(R/pan)) for each feature, adding constant 1 for linear regression offgee_log_rn
  var logRnPlots = rnPlots.map(function (feature) {
    return feature.set({
      eeLogMeanRn: ee.Number(feature.get('mean')).log10(),
      constant: 1
    });
  });

  // fit linear calibration between the EE and GEF log(mean(R/pan)) values
  var calibRes = ee.Dictionary(logRnPlots.reduceColumns({
    reducer: ee.Reducer.linearRegression({
      numX: 2,
      numY: 1
    }),
    selectors: ['eeLogMeanRn', 'constant', 'log(mean(R/pan))']
  }));
  
  print('Calibration result: ', calibRes);
  
  var calibCoeff = ee.Array(calibRes.get('coefficients')).toList();
  var calibModel = {
    m: ee.Number(ee.List(calibCoeff.get(0)).get(0)),
    c: ee.Number(ee.List(calibCoeff.get(1)).get(0))
  };

  // combine the GEF AGC and GEF->EE calibration models into one  
  var agcEeModel = {
    m: calibModel.m.multiply(gefAgcModel.m),
    c: calibModel.c.multiply(gefAgcModel.m).add(gefAgcModel.c)
  };

  // apply the new model to the EE log(R/pan) image
  var agcImage = rnImage.log10().multiply(agcEeModel.m).add(agcEeModel.c);

  return {
    model: agcEeModel,
    image: agcImage
  };
}

var agcDict = modelAgc(rnImage, trainCalibPlots);
print('EE AGC Model: ', agcDict.model);

// Check the accuracy of an AGC image using test ground truth plots
function accuracyCheck(agcImage, testPlots) {
  var gefAgcField = 'AgcHa';
  var predAgcField = 'mean';

  var agcPlots = agcImage.reduceRegions({
    reducer: ee.Reducer.mean(),
    collection: testPlots,
    scale: 1
  });

  // find residual sum of squares
  var agcResSs = agcPlots.map(function (feature) {
    return feature.set({ 
      agcRes2: (ee.Number(feature.get(predAgcField)).subtract(feature.get(gefAgcField))).pow(2) 
    });
  }).reduceColumns(ee.Reducer.sum(), ['agcRes2']);

  // convert to RMSE
  var agcRms = (ee.Number(agcResSs.get('sum')).divide(agcPlots.size())).sqrt();
  print('AGC RMSE: ', agcRms);

  // find mean GEF agc 
  var agcMean = ee.Number(agcPlots.reduceColumns(ee.Reducer.mean(), [gefAgcField]).get('mean'));

  // find sum of square differences from mean
  var agcSs = agcPlots.map(function (feature) {
    return feature.set(
      {
        agcOffPow2: (ee.Number(feature.get(gefAgcField)).subtract(agcMean)).pow(2)
      });
  }).reduceColumns(ee.Reducer.sum(), ['agcOffPow2']);

  // find correlation coefficient
  var agcR2 = ee.Number(1).subtract(ee.Number(agcResSs.get('sum')).divide(ee.Number(agcSs.get('sum'))));
  print('AGC R2: ', agcR2);
}

print('Calibration train accuracy:');
accuracyCheck(agcDict.image, trainCalibPlots);
print('Calibration test accuracy:');
accuracyCheck(agcDict.image, testCalibPlots);
print('Sampling accuracy:');
accuracyCheck(agcDict.image, gefSamplingPlots);

// sanity check on EE AGC statistics
var agcPtile = agcDict.image.reduceRegion({
  reducer: ee.Reducer.percentile([2, 98]),
  geometry: thicketBoundary,
  scale: 100,
  maxPixels: 1e8
});
print('2-98% EE AGC: ', agcPtile);

// export model and AGC image to EE assets for use in other scripts
var eeAgcModelFeat = ee.Feature(thicketBoundary.first().geometry().centroid(), agcDict.model);
var eeAgcModelColl = ee.FeatureCollection([eeAgcModelFeat]);
print(eeAgcModelColl);

Export.table.toAsset({
  collection: eeAgcModelColl,
  description: 'ee_l8_sr_agc_model',
  // fileFormat: 'CSV',
  // folder: 'Earth Engine Data'
  assetId: 'extend_thicket_agc/ee_l8_sr_agc_model',
});

if (false) {  // export AGC image 
  Export.image.toDrive({
    image: agcDict.image.uint8(),
    description: 'ee_agc_image_toDrive',
    folder: 'Earth Engine Data',
    scale: 30,
    region: ee.Feature(thicketBoundary.first()).bounds(),
    fileFormat: 'GeoTIFF',
    formatOptions: {
      cloudOptimized: true
    },
    maxPixels: 1e9,
    fileDimensions: [2048, 2048],  // break into tiles
    skipEmptyTiles: true,
    // crs: 'EPSG:3857'
  });

  Export.image.toAsset({
    image: agcDict.image.uint8(),
    description: 'ee_agc_image_toAsset',
    assetId: 'extend_thicket_agc/ee_agc_image',
    scale: 30,
    region: ee.Feature(thicketBoundary.first()).bounds(),
    maxPixels: 1e9,
    dimensions: 1024  // break into tiles
  });
}