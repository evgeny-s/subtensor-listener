import { Module } from '@nestjs/common';
import { BlockScanner } from './block-scanner.service';
import { ChainConnectionService } from './chain-connection.service';

@Module({
  providers: [ChainConnectionService, BlockScanner],
  exports: [ChainConnectionService, BlockScanner],
})
export class SubtensorModule {}
