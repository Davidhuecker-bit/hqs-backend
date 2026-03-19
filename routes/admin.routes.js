// Updated GET /admin/overview route to change persistSnapshot from true to false
router.get('/admin/overview', (req, res) => { 
    // other route logic
    const adminStack = buildAdminStack({ persistSnapshot: false }); 
    // remaining logic
});