import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiOk } from '../../common/api-ok';
import { AuthUser, CurrentUser, RequirePermission } from '../../common/auth.decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import {
  CategoryDto,
  CategoryListDto,
  CreateCategoryDto,
  CreateProductDto,
  PriceHistoryDto,
  ProductDto,
  ProductPageDto,
  ProductQueryDto,
  ProductSearchQueryDto,
  ProductSearchResultDto,
  UpdateCategoryDto,
  UpdateProductDto,
} from './products.schemas';
import { ProductsService } from './products.service';

@ApiTags('products')
@Controller()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get('products')
  @RequirePermission(P.PRODUCT_VIEW)
  @ApiOk(ProductPageDto)
  listProducts(@CurrentUser() user: AuthUser, @Query() q: ProductQueryDto) {
    return this.products.list(user, q);
  }

  @Get('products/search')
  @RequirePermission(P.PRODUCT_VIEW)
  @ApiOk(ProductSearchResultDto)
  searchProducts(@Query() q: ProductSearchQueryDto) {
    return this.products.search(q.q, q.limit);
  }

  @Get('products/:id')
  @RequirePermission(P.PRODUCT_VIEW)
  @ApiOk(ProductDto)
  getProduct(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(user, id);
  }

  @Get('products/:id/price-history')
  @RequirePermission(P.PRODUCT_VIEW)
  @ApiOk(PriceHistoryDto)
  getProductPriceHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.priceHistory(id);
  }

  @Post('products')
  @RequirePermission(P.PRODUCT_MANAGE)
  @ApiOk(ProductDto)
  createProduct(@CurrentUser() user: AuthUser, @Body() body: CreateProductDto) {
    return this.products.create(user, body);
  }

  @Patch('products/:id')
  @RequirePermission(P.PRODUCT_MANAGE)
  @ApiOk(ProductDto)
  updateProduct(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProductDto) {
    return this.products.update(user, id, body);
  }

  @Get('categories')
  @RequirePermission(P.PRODUCT_VIEW)
  @ApiOk(CategoryListDto)
  listCategories() {
    return this.products.listCategories();
  }

  @Post('categories')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(CategoryDto)
  createCategory(@CurrentUser() user: AuthUser, @Body() body: CreateCategoryDto) {
    return this.products.createCategory(user, body);
  }

  @Patch('categories/:id')
  @RequirePermission(P.SETTINGS_MANAGE)
  @ApiOk(CategoryDto)
  updateCategory(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCategoryDto) {
    return this.products.updateCategory(user, id, body);
  }
}
