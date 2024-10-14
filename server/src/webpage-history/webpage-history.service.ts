import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WebpageHistory, WebpageHistoryDocument } from './webpage-history.schema';
import { ParsedParts, ParsedPartsDocument } from './parsed-parts.schema';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';
import * as sanitizeHtml from 'sanitize-html';
import ollama from 'ollama';

@Injectable()
export class WebpageHistoryService {
  private milvusClient: MilvusClient;
  private collectionName: string;
  private databaseName: string;
  private ollama: typeof ollama;

  constructor(
    @InjectModel(WebpageHistory.name) private webpageHistoryModel: Model<WebpageHistoryDocument>,
    @InjectModel(ParsedParts.name) private parsedPartsModel: Model<ParsedPartsDocument>,
    private configService: ConfigService
  ) {
    const milvusUrl = this.configService.get<string>('MILVUS_URL') || 'http://localhost:19530';
    this.milvusClient = new MilvusClient(milvusUrl);
    this.collectionName = 'webpage_vectors';
    this.databaseName = 'instalilyDB';

    const ollamaUrl = this.configService.get<string>('OLLAMA_URL') || 'http://localhost:11434';
    this.ollama = ollama;

    this.initMilvusDatabase().catch(error => {
      console.error('Failed to initialize Milvus database:', error);
    });
  }

  private async initMilvusDatabase(retries = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        const databases = await this.milvusClient.listDatabases();
        const databaseExists = databases.db_names.some(db => db === this.databaseName);
        
        if (!databaseExists) {
          await this.milvusClient.createDatabase({ db_name: this.databaseName });
          console.log(`Database ${this.databaseName} created successfully.`);
        } else {
          console.log(`Database ${this.databaseName} already exists.`);
        }
  
        await this.milvusClient.useDatabase({ db_name: this.databaseName });
        console.log(`Using database ${this.databaseName}.`);
  
        await this.initMilvusCollection();
        return;
      } catch (error) {
        console.error(`Attempt ${i + 1} to create/use database failed:`, error);
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async initMilvusCollection(retries = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        const hasCollection = await this.milvusClient.hasCollection({ collection_name: this.collectionName });
        if (!hasCollection) {
          await this.milvusClient.createCollection({
            collection_name: this.collectionName,
            fields: [
              { name: 'id', data_type: DataType.Int64, is_primary_key: true, autoID: true },
              { name: 'url', data_type: DataType.VarChar, max_length: 65535 },
              { name: 'vector', data_type: DataType.FloatVector, dim: 1024 }
            ]
          });
          console.log(`Collection ${this.collectionName} created successfully in ${this.databaseName}.`);
        } else {
          console.log(`Collection ${this.collectionName} already exists in ${this.databaseName}.`);
        }
        return;
      } catch (error) {
        console.error(`Attempt ${i + 1} to create collection failed:`, error);
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private async ensureCollectionExists(): Promise<void> {
    try {
      await this.milvusClient.useDatabase({ db_name: this.databaseName });
      const hasCollection = await this.milvusClient.hasCollection({ collection_name: this.collectionName });
      if (!hasCollection) {
        console.log(`Collection ${this.collectionName} not found in ${this.databaseName}, recreating...`);
        await this.initMilvusCollection();
      }
    } catch (error) {
      console.error('Error checking/recreating collection:', error);
      throw error;
    }
  }

  async create(pageUrl: string, product: string, parsedContent: string): Promise<WebpageHistory> {
    return this.webpageHistoryModel.findOneAndUpdate(
        { pageUrl },
        {
          $set: {
            product,
            parsedContent,
            timestamp: new Date()
          }
        },
        { upsert: true, new: true }
      ).exec();
  }

  async findOne(pageUrl: string): Promise<WebpageHistory | null> {
    return this.webpageHistoryModel.findOne({ pageUrl }).exec();
  }

  async getProcessedProductInfo(pageUrl: string): Promise<Record<string, any> | null> {
    const webpageHistory = await this.webpageHistoryModel.findOne({ pageUrl });
    if (!webpageHistory || !webpageHistory.parsedContent) {
      return null;
    }
  
    const $ = cheerio.load(webpageHistory.parsedContent);
  
    const getTextContent = (selector: string): string => {
      return $(selector).text().trim();
    };
  
    const getWorksWithInfo = (): Array<{ brand: string; modelNumber: string; description: string }> => {
      const container = $('.pd__crossref__list');
      if (container.length === 0) return [];
  
      return container.find('.row').map((_, row) => ({
        brand: $(row).find('.col-6.col-md-3').first().text().trim(),
        modelNumber: $(row).find('.col-6.col-md-3.col-lg-2').first().text().trim(),
        description: $(row).find('.col.col-md-6.col-lg-7').first().text().trim()
      })).get();
    };
  
    const getSymptoms = (): string[] => {
      const symptomsElement = $('.col-md-6.mt-3').first();
      if (symptomsElement.length > 0) {
        const symptomsText = symptomsElement.text().trim();
        const symptomsMatch = symptomsText.match(/This part fixes the following symptoms:(.*)/s);
        if (symptomsMatch) {
          return symptomsMatch[1].trim().split('|').map(item => item.trim());
        }
      }
      return [];
    };
  
    const getWorksWithProducts = (): string => {
      const worksWithElement = $('.col-md-6.mt-3').eq(1);
      if (worksWithElement.length > 0) {
        const worksWithText = worksWithElement.text().trim();
        const worksWithMatch = worksWithText.match(/This part works with the following products:(.*)/s);
        if (worksWithMatch) {
          return worksWithMatch[1].trim();
        }
      }
      return '';
    };

    const processedInfo = {
        title: getTextContent('h1.title-lg[itemprop="name"]'),
        partSelectNumber: getTextContent('div.mt-3.mb-2 span[itemprop="productID"]'),
        manufacturerPartNumber: getTextContent('div.mb-2 span[itemprop="mpn"]'),
        manufacturer: getTextContent('span[itemprop="brand"] span[itemprop="name"]'),
        forBrands: getTextContent('span[itemprop="brand"] + span'),
        description: getTextContent('div[itemprop="description"]'),
        symptoms: getSymptoms(),
        worksWithProducts: getWorksWithProducts(),
        worksWithInfo: getWorksWithInfo(),
        replacedParts: getTextContent('.col-md-6.mt-3:nth-of-type(3) div[data-collapse-container]')
      };

    return this.parsedPartsModel.findOneAndUpdate(
        { pageUrl },
        {
          $set: processedInfo
        },
        { upsert: true, new: true }
      ).exec();
  }

  async generateVectorPage(pageUrl: string): Promise<Record<string, any> | null> {
    try {
      await this.ensureCollectionExists();
      
      const webpageContent = await this.webpageHistoryModel.findOne({ pageUrl });
      
      if (!webpageContent) {
        console.error(`No content found for URL: ${pageUrl}`);
        return null;
      }
  
      const plainText = sanitizeHtml(webpageContent.parsedContent, {
        allowedTags: [],
        allowedAttributes: {}
      });
  
      const response = await this.ollama.embeddings({
        model: 'mxbai-embed-large',
        prompt: plainText
      });
  
      const embedding = response.embedding;
  
      await this.milvusClient.useDatabase({ db_name: this.databaseName });
  
      const insertResult = await this.milvusClient.insert({
        collection_name: this.collectionName,
        fields_data: [{
          url: pageUrl,
          vector: embedding
        }]
      });
  
      return {
        url: pageUrl,
        vectorId: insertResult.IDs[0],
        embedding: embedding
      };
  
    } catch (error) {
      console.error('Error in generateVectorPage:', error);
      return null;
    }
  }
}