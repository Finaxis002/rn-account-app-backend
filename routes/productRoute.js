const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const productController = require("../controllers/productController");
const verifyUser = require("../middleware/verifyUser");
const multer = require("multer");

// Create Product
router.post("/", verifyClientOrAdmin, productController.createProduct);

router.get("/", verifyClientOrAdmin, productController.getProducts);


router.put("/:id", verifyClientOrAdmin, productController.updateProducts);
router.delete("/bulk-delete", verifyClientOrAdmin, productController.bulkDeleteProducts);
router.delete("/:id", verifyClientOrAdmin, productController.deleteProducts);

router.post("/update-stock", verifyClientOrAdmin, productController.updateStockBulk);


// Set up multer storage for file handling
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Handle the import route
router.post("/import", verifyClientOrAdmin, upload.single("file"), productController.importProductsFromFile);


module.exports = router;
