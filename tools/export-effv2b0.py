# EfficientNetV2-B0 (ImageNet, Keras Applications) → TF.js graph model that outputs, for a
# [N,288,288,3] image in [0,1], the GeM(p=3) pooled vectors of top_activation (1280) and
# block6a_expand_activation (672), concatenated → [N,1952].
import os, sys, subprocess, tensorflow as tf
S = 288
base = tf.keras.applications.EfficientNetV2B0(include_top=False, weights='imagenet', input_shape=(S, S, 3))
m = tf.keras.Model(base.input, [base.get_layer('top_activation').output, base.get_layer('block6a_expand_activation').output])
def gem(o): return tf.pow(tf.reduce_mean(tf.pow(tf.maximum(o, 1e-6), 3.0), [1, 2]), 1 / 3.0)
@tf.function(input_signature=[tf.TensorSpec([None, S, S, 3], tf.float32, name='images')])
def serve(x):
    top, mid = m(x * 255.0, training=False)
    return {'feat': tf.concat([gem(top), gem(tf.nn.relu(mid))], -1)}
tf.saved_model.save(m, 'sm_slim', signatures={'serving_default': serve})
subprocess.check_call([os.path.join(os.path.dirname(sys.executable), 'tensorflowjs_converter'), '--input_format=tf_saved_model', '--output_format=tfjs_graph_model',
                       '--signature_name=serving_default', '--quantize_float16', '*', 'sm_slim', 'effv2b0_288'])
