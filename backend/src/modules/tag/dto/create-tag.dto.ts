import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateTagDto {
  @ApiProperty({ description: '标签名称' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: '标签slug' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  slug: string;
}
