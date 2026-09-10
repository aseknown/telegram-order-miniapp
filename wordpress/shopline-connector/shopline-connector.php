<?php
/**
 * Plugin Name: Shopline Connector for WooCommerce
 * Description: Sync simple products to your Shopline store using a store-scoped token.
 * Version: 0.2.0
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 * License: GPL-2.0-or-later
 */
if (!defined('ABSPATH')) { exit; }

add_action('admin_menu', function () {
    add_submenu_page('woocommerce', 'Shopline', 'Shopline', 'manage_woocommerce', 'shopline', 'shopline_settings_page');
});

function shopline_settings_page() {
    if (!current_user_can('manage_woocommerce')) { return; }
    if (isset($_POST['shopline_save'])) {
        check_admin_referer('shopline_settings');
        $endpoint = esc_url_raw(wp_unslash($_POST['endpoint'] ?? ''));
        $parts = wp_parse_url($endpoint);
        $valid = $parts && ($parts['scheme'] ?? '') === 'https'
            && ($parts['path'] ?? '') === '/api/v1/integrations/woocommerce'
            && !isset($parts['user']) && !isset($parts['pass']) && !isset($parts['query']) && !isset($parts['fragment']);
        $token = trim(wp_unslash($_POST['token'] ?? ''));
        if (!$valid || ($token !== '' && !preg_match('/^[a-f0-9]{64}$/', $token))) {
            echo '<div class="notice notice-error"><p>Enter the HTTPS endpoint and 64-character token from your store dashboard.</p></div>';
        } else {
            $old_endpoint = get_option('shopline_endpoint', '');
            // A destination change must never forward the existing secret to a new host.
            if ($old_endpoint !== $endpoint && $token === '') {
                echo '<div class="notice notice-error"><p>Enter a new token when changing the endpoint.</p></div>';
            } else {
                update_option('shopline_endpoint', $endpoint, false);
                if ($token !== '') { update_option('shopline_token', $token, false); }
                echo '<div class="notice notice-success"><p>Connection saved.</p></div>';
            }
        }
    }
    if (isset($_POST['shopline_sync'])) {
        check_admin_referer('shopline_settings');
        if (!wp_next_scheduled('shopline_sync_page', array(1))) {
            wp_schedule_single_event(time() + 1, 'shopline_sync_page', array(1));
        }
        echo '<div class="notice notice-success"><p>Catalog sync queued. WordPress cron processes products in batches.</p></div>';
    }
    ?>
    <div class="wrap"><h1>Shopline connection</h1>
      <p>Generate a token in your Shopline merchant dashboard. The connector syncs simple products; orders stay in Shopline.</p>
      <form method="post">
        <?php wp_nonce_field('shopline_settings'); ?>
        <p><label>Marketplace endpoint<br><input class="large-text" name="endpoint" type="url" value="<?php echo esc_attr(get_option('shopline_endpoint', '')); ?>" placeholder="https://appdomain/api/v1/integrations/woocommerce"></label></p>
        <p><label>Store token<br><input class="large-text" name="token" type="password" value="" autocomplete="new-password"></label><br>Leave blank to keep the current token. Stored tokens are never displayed.</p>
        <p><button class="button button-primary" name="shopline_save" value="1">Save connection</button> <button class="button" name="shopline_sync" value="1">Sync existing products</button></p>
      </form>
      <p>Last sync result: <?php echo esc_html(get_option('shopline_sync_status', 'Not synced yet')); ?></p>
      <p>Updates, visibility and stock availability sync automatically. Variable, grouped and external products are not offered for checkout. Run a real WordPress cron for reliable delivery.</p>
    </div>
    <?php
}

function shopline_queue_product($product_id) {
    if (!get_option('shopline_token') || !get_option('shopline_endpoint')) { return; }
    if (!wp_next_scheduled('shopline_send_product', array((int)$product_id, 0))) {
        wp_schedule_single_event(time() + 5, 'shopline_send_product', array((int)$product_id, 0));
    }
}
add_action('woocommerce_new_product', 'shopline_queue_product');
add_action('woocommerce_update_product', 'shopline_queue_product');
add_action('woocommerce_delete_product', 'shopline_queue_product');
add_action('woocommerce_trash_product', 'shopline_queue_product');
add_action('woocommerce_product_set_stock', function ($product) { shopline_queue_product($product->get_id()); });
add_action('woocommerce_product_set_stock_status', 'shopline_queue_product');

add_action('shopline_sync_page', function ($page) {
    if (!function_exists('wc_get_products')) { return; }
    $ids = wc_get_products(array('limit' => 20, 'page' => (int)$page, 'return' => 'ids', 'orderby' => 'ID', 'order' => 'ASC', 'status' => array('publish', 'draft', 'private', 'pending')));
    foreach ($ids as $product_id) { shopline_queue_product($product_id); }
    if (count($ids) === 20) { wp_schedule_single_event(time() + 30, 'shopline_sync_page', array((int)$page + 1)); }
});

add_action('shopline_send_product', function ($product_id, $attempt) {
    if (!function_exists('wc_get_product')) { return; }
    $endpoint = get_option('shopline_endpoint', '');
    $token = get_option('shopline_token', '');
    if (!$endpoint || !$token) { return; }
    $product = wc_get_product($product_id);
    $simple = $product && $product->is_type('simple');
    $price = $simple ? $product->get_price() : '0';
    $active = $simple && $product->get_status() === 'publish' && $product->is_in_stock()
        && $product->get_catalog_visibility() !== 'hidden' && $price !== '';
    // Use the current snapshot on each retry; later snapshots supersede delayed ones.
    $payload = array(
        'source_id' => (string)$product_id,
        'name' => $product ? wp_html_excerpt(wp_strip_all_tags($product->get_name()), 120, '') : 'Removed product',
        'description' => $product ? wp_html_excerpt(wp_strip_all_tags($product->get_short_description()), 1000, '') : '',
        'price' => $price === '' ? '0' : $price,
        'currency' => get_woocommerce_currency(),
        'active' => (bool)$active,
        'archived' => !$product || $product->get_status() === 'trash',
        'version' => (int)floor(microtime(true) * 1000000)
    );
    $response = wp_safe_remote_post($endpoint, array(
        'timeout' => 15, 'redirection' => 0,
        'headers' => array('Authorization' => 'Bearer ' . $token, 'Content-Type' => 'application/json'),
        'body' => wp_json_encode($payload), 'limit_response_size' => 4096
    ));
    $status = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);
    if ($status >= 200 && $status < 300) {
        update_option('shopline_sync_status', 'Product ' . (int)$product_id . ' synced at ' . gmdate('c'), false);
        return;
    }
    // Avoid persisting response bodies or credentials in logs/options.
    update_option('shopline_sync_status', 'Product ' . (int)$product_id . ': HTTP ' . (int)$status . '. Check connection, currency and product price.', false);
    if (($status === 0 || $status === 429 || $status >= 500) && $attempt < 7) {
        wp_schedule_single_event(time() + min(3600, 30 * (2 ** $attempt)), 'shopline_send_product', array((int)$product_id, (int)$attempt + 1));
    }
}, 10, 2);

register_deactivation_hook(__FILE__, function () {
    wp_unschedule_hook('shopline_send_product');
    wp_unschedule_hook('shopline_sync_page');
});
