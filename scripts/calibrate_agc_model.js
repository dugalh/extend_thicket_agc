/**** Start of imports. If edited, may not auto-convert in the playground. ****/
var step_arid_and_valley_thicket = ee.FeatureCollection("users/dugalh/extend_thicket_agc/step_arid_and_valley_thicket"),
    gef_calib_plots = ee.FeatureCollection("users/dugalh/extend_thicket_agc/gef_calib_plots"),
    gef_sampling_plots = ee.FeatureCollection("users/dugalh/extend_thicket_agc/gef_sampling_plots");
/***** End of imports. If edited, may not auto-convert in the playground. *****/
// Calibrate the GEF AGC model to Landsat / Sentinel imagery and evaluate accuracy 

var cloud_masking = require('users/dugalh/extend_thicket_agc:modules/cloud_masking.js');
var thicket_boundary = step_arid_and_valley_thicket;  // STEP derived thicket boundaries
var gef_agc_model = {m: ee.Number(-318.8304), c: ee.Number(25.7259)}; // the univariate log(mean(R/pan)) WV3 model

// convert kg to tonnes
gef_sampling_plots = gef_sampling_plots.map(function(feature){
  return feature.gee_log_rn({
    AgcHa: ee.Number(feature.get('AgcHa')).divide(1000)
  })
});

// var s2_toa_images = ee.ImageCollection('COPERNICUS/S2')
//                   .filterDate('2017-09-01', '2017-11-01')
//                   .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 5))
//                   .filterBounds(thicket_boundary)
//                   .map(cloud_masking.s2_simple_cloud_mask);

var l8_sr_images = ee.ImageCollection('LANDSAT/LC08/C01/T1_SR') //ee.ImageCollection('LANDSAT/LE07/C01/T1_SR')  
                    .filterDate('2017-09-01', '2017-12-30')
                    .filterBounds(thicket_boundary)
                    .map(cloud_masking.landsat8_sr_cloud_mask);

var images = l8_sr_images;
print('No images: ', images.size());
var image = images.median();    // composite the image collection

// Find R/pan image feature
function find_rn(image) {
  var rn_image = image.expression('(R / (R + G + B + RE))', 
              {
                'R': image.select('B4'),
                'G': image.select('B3'),
                'B': image.select('B2'),
                'RE': image.select(ee.Algorithms.If(image.bandNames().contains('B8'), 'B8', 'B5'))
              });
  return ee.Image(rn_image);
}
var rn_image = find_rn(image);

// Split train and test data
var split = 0.5;  
var calib_plots = gef_calib_plots.randomColumn('random', 0);
var train_calib_plots = calib_plots.filter(ee.Filter.lt('random', split));
var test_calib_plots = calib_plots.filter(ee.Filter.gte('random', split));

// Calibrate the GEF AGC model to EE imagery and find EE AGC
function model_agc(rn_image, train_plots) {
  
  // find mean(R/pan) for each calibration plot
  var rn_plots = rn_image.reduceRegions({
    reducer: ee.Reducer.mean(),
    collection: train_plots,
    scale: 1});

  // find log(mean(R/pan)) for each feature, adding constant 1 for linear regression offgee_log_rn
  var log_rn_plots = rn_plots.map(function(feature) {
    return feature.gee_log_rn({ee_log_mean_rn: ee.Number(feature.get('mean_rn')).log10(), constant: 1});
  });

  // fit linear calibration between the EE and GEF log(mean(R/pan)) values
  var calib_res = ee.Dictionary(log_rn_plots.reduceColumns({
    reducer: ee.Reducer.linearRegression({
      numX: 2,
      numY: 1
    }),
    selectors: ['ee_log_mean_rn', 'constant', 'log(mean(R/pan))']
  }));
  print ('Calibration result: ', calib_res);
  var calib_coeff = ee.Array(calib_res.get('coefficients')).toList();
  var calib_model = {
    m: ee.Number(ee.List(calib_coeff.get(0)).get(0)), 
    c: ee.Number(ee.List(calib_coeff.get(1)).get(0))
  };

  // combine the GEF AGC and GEF->EE calibration models into one  
  var agc_ee_model = {
    m: calib_model.m.multiply(agc_model.m), 
    c: calib_model.c.multiply(agc_model.m).add(agc_model.c)
  };
  
  // apply the new model to the EE log(R/pan) image
  var agc_image = rn_image.log10().multiply(agc_ee_model.m).add(agc_ee_model.c);
  
  return {
    model: agc_ee_model, 
    agc: agc_image
  };
}
var agc_image = model_agc(rn_image, train_calib_plots);

print('Calibration train accuracy:');
accuracy_check(agc_image, train_calib_plots);
print('Calibration test accuracy:');
accuracy_check(agc_image, test_calib_plots);
print('Sampling accuracy:');
accuracy_check(agc_image, gef_sampling_plots);

if (false)
{
  var min_agc = agc_image.reduceRegion({
    reducer: ee.Reducer.min(),
    geometry: thicket_boundary,
    scale: 100,
    maxPixels: 1e8
  });
  
  print('min_agc: ', min_agc)
  
  var max_agc = agc_image.reduceRegion({
    reducer: ee.Reducer.max(),
    geometry: thicket_boundary,
    scale: 100,
    maxPixels: 1e8
  });
  print('max_agc: ', max_agc)

  var p_agc = agc_image.reduceRegion({
    reducer: ee.Reducer.percentile([2,5,95,98]),
    geometry: thicket_boundary,
    scale: 100,
    maxPixels: 1e8
  });
  print('5-95% AGC: ', p_agc)
}
